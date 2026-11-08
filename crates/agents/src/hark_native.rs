use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOptions,
};
use serde_json::Value;

pub(crate) const HARK_RUNTIME_ENV_KEYS: &[&str] = &[
    "DSH_HOME",
    "DSH_ROOT",
    "DSH_AUTH_MODE",
    "DSH_SESSIONS_ROOT",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_ACP_BASE_URL",
    "DEEPSEEK_ACP_PROVIDER",
    "DEEPSEEK_ACP_MODEL",
    "DEEPSEEK_ACP_SESSIONS_ROOT",
    "HARK_API_KEY",
    "HARK_CLIENT_TOOL_CONTRACT",
    "HARK_CLIENT_TOOL_CONTRACT_HOME",
];

pub(crate) struct HarkNativeSelection {
    pub provider: String,
    pub model: String,
    pub credential_env: String,
    pub credential: String,
    pub models: Vec<String>,
}

pub(crate) fn selection_from_documents(
    settings: &Value,
    credentials: &Value,
) -> Result<Option<HarkNativeSelection>, String> {
    if !settings.is_null() && !settings.is_object() {
        return Err("Hark settings.yaml must be a YAML object".to_string());
    }
    if !credentials.is_null() && !credentials.is_object() {
        return Err("Hark .credentials.yaml must be a YAML object".to_string());
    }
    let Some(selection) = settings.get("hark") else {
        return Ok(None);
    };
    let provider = required_text(selection, "provider", "hark")?;
    let model = required_text(selection, "model", "hark")?;
    let definition = settings
        .get("llm-pi-ai")
        .and_then(|llm| llm.get("providers"))
        .and_then(|providers| providers.get(provider))
        .ok_or_else(|| format!("Hark provider `{provider}` is missing from llm-pi-ai.providers"))?;
    let api = required_text(definition, "api", "Hark provider")?;
    if !matches!(
        api,
        "openai-completions" | "openai-responses" | "anthropic-messages"
    ) {
        return Err(format!("Hark provider `{provider}` has an unsupported api"));
    }
    let endpoint = required_text(definition, "baseURL", "Hark provider")?;
    let endpoint = url::Url::parse(endpoint)
        .map_err(|_| format!("Hark provider `{provider}` baseURL must be an HTTP(S) URL"))?;
    if !matches!(endpoint.scheme(), "http" | "https") || endpoint.host_str().is_none() {
        return Err(format!(
            "Hark provider `{provider}` baseURL must be an HTTP(S) URL"
        ));
    }
    let models = definition.get("models").and_then(Value::as_array);
    if !models.is_some_and(|models| {
        models
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(model))
    }) {
        return Err(format!(
            "Hark model `{model}` is missing from provider `{provider}` models"
        ));
    }
    let credential_env = required_text(definition, "apiKeyEnv", "Hark provider")?;
    if !credential_env.chars().enumerate().all(|(index, ch)| {
        ch == '_' || ch.is_ascii_alphabetic() || (index > 0 && ch.is_ascii_digit())
    }) {
        return Err("Hark provider apiKeyEnv must name an environment variable".to_string());
    }
    if HARK_RUNTIME_ENV_KEYS
        .iter()
        .chain(["HARK_HOME", "HOME", "USERPROFILE", "PATH", "NODE_OPTIONS"].iter())
        .any(|key| key.eq_ignore_ascii_case(credential_env))
        && !credential_env.eq_ignore_ascii_case("HARK_API_KEY")
    {
        return Err("Hark provider apiKeyEnv conflicts with runtime routing".to_string());
    }
    if credentials
        .as_object()
        .is_none_or(|document| document.is_empty())
    {
        return Ok(None);
    }
    if credentials.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Hark .credentials.yaml version must be 1".to_string());
    }
    if credentials
        .get("refs")
        .is_some_and(|refs| !refs.is_object())
    {
        return Err("Hark .credentials.yaml refs must be an object".to_string());
    }
    if credentials
        .get("refs")
        .and_then(|refs| refs.get(credential_env))
        .is_some_and(|key| !key.is_string())
    {
        return Err("Hark provider credential must be a string".to_string());
    }
    let Some(credential) = credentials
        .get("refs")
        .and_then(|refs| refs.get(credential_env))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        return Ok(None);
    };
    if credential.chars().any(char::is_control) {
        return Err("Hark provider credential must be a single line".to_string());
    }
    Ok(Some(HarkNativeSelection {
        provider: provider.to_string(),
        model: model.to_string(),
        credential_env: credential_env.to_string(),
        credential: credential.to_string(),
        models: models
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
            .collect(),
    }))
}

fn required_text<'a>(value: &'a Value, field: &str, context: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{context}.{field} must be a non-empty string"))
}

/// Project the selected native provider into the shared ACP engine. Callers
/// propagate configuration errors before spawning; no official route is a fallback.
pub fn apply_hark_native_launch_env(env: &mut HashMap<String, String>) -> Result<(), String> {
    env.retain(|key, _| {
        !HARK_RUNTIME_ENV_KEYS
            .iter()
            .any(|legacy| key.eq_ignore_ascii_case(legacy))
    });
    let (agent_dir, selection) = read_native_selection(env)?;
    install_execution_contract(&agent_dir, env)?;
    env.insert(
        "DSH_HOME".to_string(),
        agent_dir.to_string_lossy().into_owned(),
    );
    env.insert(
        "DEEPSEEK_ACP_SESSIONS_ROOT".to_string(),
        agent_dir.join("sessions").to_string_lossy().into_owned(),
    );
    env.insert("DEEPSEEK_ACP_PROVIDER".to_string(), selection.provider);
    env.insert("DEEPSEEK_ACP_MODEL".to_string(), selection.model);
    env.insert(selection.credential_env, selection.credential);
    Ok(())
}

fn install_execution_contract(
    agent_dir: &Path,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    const SOURCE: &str = include_str!("hark_short_confirmation.mjs");
    let directory = agent_dir.join("runtime");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Hark execution runtime directory: {error}"))?;
    let path = directory.join("hark-execution-contract.mjs");
    if std::fs::read(&path).ok().as_deref() != Some(SOURCE.as_bytes()) {
        let staging = directory.join(format!(".hark-execution-{}.tmp", uuid::Uuid::new_v4()));
        if let Err(error) =
            std::fs::write(&staging, SOURCE).and_then(|()| std::fs::rename(&staging, &path))
        {
            let _ = std::fs::remove_file(&staging);
            return Err(format!("Hark execution runtime installation: {error}"));
        }
    }
    let url = url::Url::from_file_path(&path)
        .map_err(|()| "Hark execution runtime requires an absolute path".to_string())?;
    let import = format!("--import={url}");
    let previous = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("NODE_OPTIONS"))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("NODE_OPTIONS").ok())
        .unwrap_or_default();
    let options = if previous.split_whitespace().any(|option| option == import) {
        previous
    } else {
        format!("{} {import}", previous.trim()).trim().to_string()
    };
    env.retain(|key, _| !key.eq_ignore_ascii_case("NODE_OPTIONS"));
    env.insert("NODE_OPTIONS".to_string(), options);
    env.insert("HARK_CLIENT_TOOL_CONTRACT".to_string(), "1".to_string());
    env.insert(
        "HARK_CLIENT_TOOL_CONTRACT_HOME".to_string(),
        agent_dir.to_string_lossy().into_owned(),
    );
    Ok(())
}

fn read_native_selection(
    env: &HashMap<String, String>,
) -> Result<(PathBuf, HarkNativeSelection), String> {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Hark home directory is unavailable".to_string())?;
    let override_dir = env
        .get("HARK_HOME")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .or_else(|| std::env::var("HARK_HOME").ok())
        .filter(|value| !value.trim().is_empty());
    let agent_dir = override_dir
        .map(|directory| {
            let directory = PathBuf::from(directory.trim());
            if directory == Path::new("~") {
                home.clone()
            } else if let Ok(relative) = directory.strip_prefix("~/") {
                home.join(relative)
            } else if directory.is_relative() {
                home.join(directory)
            } else {
                directory
            }
        })
        .unwrap_or_else(|| home.join(".hark/agent"));
    let settings = read_document(&agent_dir.join("settings.yaml"))?;
    let credentials = read_document(&agent_dir.join(".credentials.yaml"))?;
    let selection = selection_from_documents(&settings, &credentials)?
        .ok_or_else(|| "Hark requires a selected model provider and its API key".to_string())?;
    Ok((agent_dir, selection))
}

/// The shared engine always advertises its official route. Hark only exposes
/// models explicitly configured on its selected native provider.
pub(crate) fn filter_hark_model_options(
    env: &HashMap<String, String>,
    options: &mut Vec<SessionConfigOption>,
    model_ids: &mut Vec<String>,
) {
    let selection = read_native_selection(env)
        .ok()
        .map(|(_, selection)| selection);
    let allowed = |value: &str| {
        selection.as_ref().is_some_and(|selection| {
            selection
                .models
                .iter()
                .any(|model| value == model || value == format!("{}::{model}", selection.provider))
        })
    };
    options.retain_mut(|option| {
        if option.id.0.as_ref() != "model" {
            return true;
        }
        let SessionConfigKind::Select(select) = &mut option.kind else {
            return false;
        };
        match &mut select.options {
            SessionConfigSelectOptions::Ungrouped(choices) => {
                choices.retain(|choice| allowed(choice.value.0.as_ref()));
                !choices.is_empty()
            }
            SessionConfigSelectOptions::Grouped(groups) => {
                groups.retain_mut(|group| {
                    if !selection
                        .as_ref()
                        .is_some_and(|selection| group.group.0.as_ref() == selection.provider)
                    {
                        return false;
                    }
                    group
                        .options
                        .retain(|choice| allowed(choice.value.0.as_ref()));
                    !group.options.is_empty()
                });
                !groups.is_empty()
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    });
    model_ids.retain(|value| allowed(value));
}

pub(crate) fn validate_hark_current_model(
    env: &HashMap<String, String>,
    options: &[SessionConfigOption],
) -> Result<(), String> {
    let (_, selection) = read_native_selection(env)?;
    for option in options
        .iter()
        .filter(|option| option.id.0.as_ref() == "model")
    {
        let SessionConfigKind::Select(select) = &option.kind else {
            return Err("Hark model selector must be a select option".to_string());
        };
        let current = select.current_value.0.as_ref();
        if !selection
            .models
            .iter()
            .any(|model| current == model || current == format!("{}::{model}", selection.provider))
        {
            return Err(
                "Hark current model is not configured on its selected native provider".to_string(),
            );
        }
    }
    Ok(())
}

fn read_document(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(format!("Hark {}: {error}", path.display())),
    };
    serde_yaml::from_str(&text).map_err(|error| format!("Hark {}: {error}", path.display()))
}
