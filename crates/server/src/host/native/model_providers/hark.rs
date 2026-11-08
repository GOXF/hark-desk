use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::Value;
use serde_yaml::{Mapping, Value as YamlValue};

use super::common::*;
use crate::host::native::{NativeError, model_provider_import::ImportDraft};

const PROVIDER_ID: &str = "vibex";
const API_KEY_ENV: &str = "HARK_API_KEY";
const SUPPORTED_APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
];
const SETTINGS_FIELDS: &[&[&str]] = &[
    &["hark", "provider"],
    &["hark", "model"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "apiKeyEnv"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "displayName"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "api"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "baseURL"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "models"],
    &["llm-pi-ai", "providers", PROVIDER_ID, "modelOverrides"],
];
const CREDENTIAL_FIELDS: &[&[&str]] = &[&["version"], &["refs", API_KEY_ENV]];

pub(super) async fn capture_hark_projection(
    home: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), NativeError> {
    for (file, fields) in [
        ("settings.yaml", SETTINGS_FIELDS),
        (".credentials.yaml", CREDENTIAL_FIELDS),
    ] {
        let (mapping, original) = read_yaml_document(&home.join(file)).await?;
        let root = YamlValue::Mapping(mapping);
        backup
            .file_values
            .insert(file.to_string(), original.map(|_| String::new()));
        for field in fields {
            let value = field.iter().try_fold(&root, |value, key| value.get(*key));
            backup.json_values.insert(
                format!("{file}:{}", field.join(".")),
                value
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    Ok(())
}

pub(super) async fn restore_hark_projection(
    home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), NativeError> {
    let mut mutations = Vec::new();
    for (file, fields, sensitive) in [
        ("settings.yaml", SETTINGS_FIELDS, false),
        (".credentials.yaml", CREDENTIAL_FIELDS, true),
    ] {
        let path = home.join(file);
        let (mut mapping, original) = read_yaml_document(&path).await?;
        for field in fields {
            let value = backup
                .json_values
                .get(&format!("{file}:{}", field.join(".")))
                .and_then(Option::as_ref)
                .map(serde_yaml::to_value)
                .transpose()
                .map_err(|error| error.to_string())?;
            restore_yaml_field(&mut mapping, field, value)?;
        }
        if sensitive
            && !mapping.contains_key(YamlValue::String("version".into()))
            && ["refs", "records"].iter().any(|key| {
                mapping
                    .get(YamlValue::String((*key).to_string()))
                    .and_then(YamlValue::as_mapping)
                    .is_some_and(|entries| !entries.is_empty())
            })
        {
            mapping.insert(
                YamlValue::String("version".into()),
                YamlValue::Number(1.into()),
            );
        }
        let was_present = backup.file_values.get(file).is_some_and(Option::is_some);
        let replacement = if mapping.is_empty() && !was_present {
            None
        } else {
            Some(
                serde_yaml::to_string(&mapping)
                    .map_err(|error| error.to_string())?
                    .into_bytes(),
            )
        };
        mutations.push(NativeFileMutation {
            path,
            expected: original,
            replacement,
            sensitive,
        });
    }
    apply_projection_mutations(&mutations).await
}

fn restore_yaml_field(
    mapping: &mut Mapping,
    path: &[&str],
    value: Option<YamlValue>,
) -> Result<(), NativeError> {
    let key = YamlValue::String(path[0].to_string());
    if path.len() == 1 {
        if let Some(value) = value {
            mapping.insert(key, value);
        } else {
            mapping.remove(&key);
        }
        return Ok(());
    }
    if value.is_some() && !mapping.contains_key(&key) {
        mapping.insert(key.clone(), YamlValue::Mapping(Mapping::new()));
    }
    if let Some(child) = mapping.get_mut(&key) {
        let child = child.as_mapping_mut().ok_or_else(|| {
            NativeError::from(format!("Hark 配置字段 `{}` 已被外部更改类型", path[0]))
        })?;
        restore_yaml_field(child, &path[1..], value)?;
        if child.is_empty() {
            mapping.remove(&key);
        }
    }
    Ok(())
}

pub(super) fn validate_hark_model(raw: &str) -> Result<(), NativeError> {
    hark_model(raw).map(|_| ())
}

pub(super) fn reconcile_hark_binding(
    store: &mut ProviderStore,
    agent_id: &api_types::AgentId,
    native: &[NativeProviderDraft],
) -> bool {
    if agent_id.as_str() != "hark" {
        return false;
    }
    let Some(bound_id) = store.bindings.get("hark") else {
        return false;
    };
    let matches_native = store.providers.iter().any(|provider| {
        &provider.id == bound_id
            && native.first().is_some_and(|native| {
                provider.api_url == native.api_url
                    && provider.api_key == native.api_key
                    && hark_model(&provider.model).ok() == hark_model(&native.model).ok()
            })
    });
    if matches_native {
        return false;
    }
    store.bindings.remove("hark");
    store.projection_backups.remove("hark");
    true
}

pub(super) async fn project_hark_view(
    store: &mut ProviderStore,
    store_path: &Path,
    hark_home: Option<&Path>,
    agent_id: api_types::AgentId,
) -> Result<api_types::AgentModelProvidersView, NativeError> {
    let native = match hark_home {
        Some(home) => native_hark_draft(home).await?,
        None => None,
    };
    let drafts = custom_endpoint_drafts(&agent_id, native.clone().into_iter().collect());
    if hark_home.is_some() && reconcile_hark_binding(store, &agent_id, &drafts) {
        write_store(store_path, store).await?;
    }
    let mut view = project(store, agent_id.clone());
    if view.bound_provider_id.is_none()
        && let Some(native) = native
    {
        view.bound_provider_id = Some(native.source_id.clone());
        view.providers.push(api_types::AgentModelProviderView {
            id: native.source_id,
            name: native.name,
            agent_id,
            api_url: native.api_url,
            model: native.model,
            api_key: String::new(),
            credential_present: !native.api_key.is_empty(),
            bound: true,
            managed: false,
        });
    }
    Ok(view)
}

fn hark_model(raw: &str) -> Result<(String, String, Vec<YamlValue>), NativeError> {
    let model = parse_model(raw);
    let api = model
        .get("api")
        .map(|value| value.as_str().unwrap_or(""))
        .unwrap_or("openai-completions");
    if !SUPPORTED_APIS.contains(&api) {
        return Err(
            "Hark Provider 协议必须是 OpenAI Chat、OpenAI Responses 或 Anthropic Messages".into(),
        );
    }
    let ids = provider_model_ids(raw);
    let default_model = ids
        .first()
        .cloned()
        .ok_or_else(|| NativeError::from("Hark Provider 至少需要一个模型"))?;
    let declared = model.get("models").and_then(Value::as_array);
    let models = ids
        .into_iter()
        .map(|id| {
            let source = declared.and_then(|models| {
                models
                    .iter()
                    .find(|model| model.get("id").and_then(Value::as_str) == Some(id.as_str()))
            });
            let mut entry = Mapping::new();
            entry.insert(YamlValue::String("id".into()), YamlValue::String(id));
            if let Some(source) = source {
                for key in [
                    "name",
                    "contextWindow",
                    "maxTokens",
                    "input",
                    "reasoningEfforts",
                    "compat",
                ] {
                    if let Some(value) = source.get(key) {
                        entry.insert(
                            YamlValue::String(key.to_string()),
                            serde_yaml::to_value(value).map_err(|error| error.to_string())?,
                        );
                    }
                }
            }
            Ok(YamlValue::Mapping(entry))
        })
        .collect::<Result<Vec<_>, NativeError>>()?;
    Ok((api.to_string(), default_model, models))
}

pub(super) async fn apply_hark(
    hark_home: &Path,
    provider: &StoredProvider,
) -> Result<(), NativeError> {
    let (api, model, models) = hark_model(&provider.model)?;
    let settings_path = hark_home.join("settings.yaml");
    let credentials_path = hark_home.join(".credentials.yaml");
    let (mut settings, settings_original) = read_yaml_document(&settings_path).await?;
    let (mut credentials, credentials_original) = read_yaml_document(&credentials_path).await?;
    let version_key = YamlValue::String("version".into());
    if credentials
        .get(&version_key)
        .is_some_and(|version| version.as_u64() != Some(1))
    {
        return Err("Hark 凭据文件版本必须为 1".into());
    }
    credentials.insert(version_key, YamlValue::Number(1.into()));
    let refs = mapping_entry(&mut credentials, "refs")?;
    set_text(refs, API_KEY_ENV, &provider.api_key);
    let selection = mapping_entry(&mut settings, "hark")?;
    set_text(selection, "provider", PROVIDER_ID);
    set_text(selection, "model", &model);
    let engine = mapping_entry(&mut settings, "llm-pi-ai")?;
    let providers = mapping_entry(engine, "providers")?;
    let native = mapping_entry(providers, PROVIDER_ID)?;
    set_text(native, "apiKeyEnv", API_KEY_ENV);
    set_text(native, "displayName", &provider.name);
    set_text(native, "api", &api);
    set_text(native, "baseURL", &provider.api_url);
    native.insert(
        YamlValue::String("models".into()),
        YamlValue::Sequence(models),
    );
    // A declared model list replaces the catalog that modelOverrides would edit.
    native.remove(YamlValue::String("modelOverrides".into()));
    apply_projection_mutations(&[
        yaml_mutation(settings_path, settings_original, &settings, false)?,
        yaml_mutation(credentials_path, credentials_original, &credentials, true)?,
    ])
    .await
}

pub(super) async fn native_hark_draft(hark_home: &Path) -> Result<Option<ImportDraft>, String> {
    let (settings, _) = read_yaml_document(&hark_home.join("settings.yaml"))
        .await
        .map_err(String::from)?;
    let settings = YamlValue::Mapping(settings);
    let Some(provider_id) = settings["hark"]["provider"]
        .as_str()
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let native = &settings["llm-pi-ai"]["providers"][provider_id];
    let api_url = native["baseURL"].as_str().unwrap_or("").trim();
    if api_url.is_empty() {
        return Ok(None);
    }
    let (credentials, _) = read_yaml_document(&hark_home.join(".credentials.yaml"))
        .await
        .map_err(String::from)?;
    let credentials = YamlValue::Mapping(credentials);
    let key_env = native["apiKeyEnv"].as_str().unwrap_or("");
    let api_key = credentials["refs"][key_env].as_str().unwrap_or("");
    let models = serde_json::to_value(&native["models"]).map_err(|error| error.to_string())?;
    let model = serde_json::json!({
        "id": settings["hark"]["model"].as_str().unwrap_or(""),
        "api": native["api"].as_str().unwrap_or("openai-completions"),
        "models": models,
    });
    Ok(Some(ImportDraft {
        source_id: "__native_live__".to_string(),
        name: native["displayName"]
            .as_str()
            .unwrap_or(provider_id)
            .to_string(),
        api_url: api_url.to_string(),
        api_key: api_key.to_string(),
        model: model.to_string(),
        skip_reason: None,
    }))
}

async fn read_yaml_document(path: &Path) -> Result<(Mapping, Option<Vec<u8>>), NativeError> {
    let original = TokioNativeFileSystem.read(path).await?;
    let value = match original.as_deref() {
        Some(bytes) => serde_yaml::from_slice(bytes)
            .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?,
        None => YamlValue::Null,
    };
    match value {
        YamlValue::Null => Ok((Mapping::new(), original)),
        YamlValue::Mapping(mapping) => Ok((mapping, original)),
        _ => Err(format!("{} 顶层必须是对象", path.display()).into()),
    }
}

fn mapping_entry<'a>(mapping: &'a mut Mapping, key: &str) -> Result<&'a mut Mapping, NativeError> {
    mapping
        .entry(YamlValue::String(key.to_string()))
        .or_insert_with(|| YamlValue::Mapping(Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| format!("Hark 原生配置字段 `{key}` 必须是对象").into())
}

fn set_text(mapping: &mut Mapping, key: &str, value: &str) {
    mapping.insert(
        YamlValue::String(key.to_string()),
        YamlValue::String(value.to_string()),
    );
}

fn yaml_mutation(
    path: std::path::PathBuf,
    expected: Option<Vec<u8>>,
    mapping: &Mapping,
    sensitive: bool,
) -> Result<NativeFileMutation, NativeError> {
    let bytes = serde_yaml::to_string(mapping)
        .map_err(|error| format!("序列化 Hark 配置失败：{error}"))?
        .into_bytes();
    Ok(NativeFileMutation {
        path,
        expected,
        replacement: Some(bytes),
        sensitive,
    })
}
