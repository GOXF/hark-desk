use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

use agents::{AgentId, BuiltInProfileCatalog, ProfileInstallSource};
use api_types::{AgentKind, AgentSettingsFeature};

#[test]
fn hark_is_a_distinct_provider_only_built_in_agent() {
    assert!(AgentKind::from_lenient("hark").is_some());
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog
        .profile(&AgentId::parse("hark").unwrap())
        .expect("Hark is available as its own built-in Agent");
    assert_eq!(profile.display_name, "Hark");
    assert!(profile.registry_binding.is_none());
    assert!(profile.management_actions.is_empty());
    assert!(profile.authentication_required_by_default);
    assert_eq!(
        profile.settings_features,
        &[
            AgentSettingsFeature::AuthenticationMode,
            AgentSettingsFeature::ReusableModelProviders,
        ]
    );
    assert!(matches!(
        &profile.install_sources[0],
        ProfileInstallSource::Npx {
            package: "deepseek-acp",
            version: "0.9.0",
            command: "deepseek-acp",
            ..
        }
    ));
    let policy = agents::built_in_auth_mode_policy(&profile.agent_id).unwrap();
    assert_eq!(policy.modes, &["model_provider"]);
    assert_eq!(policy.default_mode, "model_provider");
}

#[tokio::test]
async fn hark_key_without_a_selected_provider_does_not_pass_native_precheck() {
    let home = tempfile::tempdir().unwrap();
    let agent_dir = home.path().join(".hark/agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join(".credentials.yaml"),
        "version: 1\nrefs:\n  HARK_API_KEY: hark-test-key\n",
    )
    .unwrap();
    let provider = agents::NativeConfigProvider::bundled(
        Arc::new(agents::TokioNativeFileSystem),
        home.path().to_path_buf(),
    );
    let snapshot = provider
        .read(&AgentId::parse("hark").unwrap(), false)
        .await
        .unwrap();
    assert_eq!(
        snapshot.authentication,
        agents::AgentAuthenticationStatus::NotLoggedIn
    );
}

#[test]
fn hark_launch_uses_the_selected_provider_and_an_isolated_native_home() {
    let home = tempfile::tempdir().unwrap();
    let agent_dir = home.path().join("custom-hark");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.yaml"),
        "hark:\n  provider: vibex\n  model: selected-model\nllm-pi-ai:\n  providers:\n    vibex:\n      api: openai-responses\n      baseURL: https://models.example/v1\n      apiKeyEnv: THIRD_PARTY_API_KEY\n      models:\n        - id: selected-model\n",
    )
    .unwrap();
    std::fs::write(
        agent_dir.join(".credentials.yaml"),
        "version: 1\nrefs:\n  THIRD_PARTY_API_KEY: selected-test-key\n",
    )
    .unwrap();
    let mut env = HashMap::from([
        (
            "HARK_HOME".to_string(),
            agent_dir.to_string_lossy().into_owned(),
        ),
        ("DSH_HOME".to_string(), "old-deepseek-home".to_string()),
        ("DSH_AUTH_MODE".to_string(), "deepseek".to_string()),
        (
            "DEEPSEEK_API_KEY".to_string(),
            "inherited-test-key".to_string(),
        ),
        (
            "DEEPSEEK_BASE_URL".to_string(),
            "https://wrong.example".to_string(),
        ),
        (
            "DEEPSEEK_ACP_PROVIDER".to_string(),
            "deepseek-official".to_string(),
        ),
        ("DEEPSEEK_ACP_MODEL".to_string(), "old-model".to_string()),
        (
            "DEEPSEEK_ACP_SESSIONS_ROOT".to_string(),
            "old-sessions".to_string(),
        ),
        (
            "THIRD_PARTY_API_KEY".to_string(),
            "stale-test-key".to_string(),
        ),
    ]);
    agents::apply_built_in_launch_policy(
        &AgentId::parse("hark").unwrap(),
        &mut env,
        &mut Vec::new(),
    );
    assert_eq!(
        env.get("DSH_HOME"),
        Some(&agent_dir.to_string_lossy().into_owned())
    );
    assert_eq!(
        env.get("DEEPSEEK_ACP_PROVIDER").map(String::as_str),
        Some("vibex")
    );
    assert_eq!(
        env.get("DEEPSEEK_ACP_MODEL").map(String::as_str),
        Some("selected-model")
    );
    assert_eq!(
        env.get("THIRD_PARTY_API_KEY").map(String::as_str),
        Some("selected-test-key")
    );
    assert_eq!(
        env.get("DEEPSEEK_ACP_SESSIONS_ROOT"),
        Some(&agent_dir.join("sessions").to_string_lossy().into_owned())
    );
    for key in ["DSH_AUTH_MODE", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] {
        assert!(!env.contains_key(key), "{key} must not leak from DeepSeek");
    }
}

fn write_selected_provider(directory: &Path, api: &str, model: &str) {
    std::fs::create_dir_all(directory).unwrap();
    let settings = serde_json::json!({
        "hark": { "provider": "vibex", "model": model },
        "llm-pi-ai": { "providers": { "vibex": {
            "api": api,
            "baseURL": "https://models.example/v1",
            "apiKeyEnv": "HARK_API_KEY",
            "models": [{ "id": model }]
        }}}
    });
    std::fs::write(directory.join("settings.yaml"), settings.to_string()).unwrap();
    std::fs::write(
        directory.join(".credentials.yaml"),
        "version: 1\nrefs:\n  HARK_API_KEY: selected-test-key\n",
    )
    .unwrap();
}

#[tokio::test]
async fn hark_precheck_checks_selected_credentials_and_native_protocols() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("hark");
    let provider = agents::NativeConfigProvider::with_environment(
        Arc::new(agents::TokioNativeFileSystem),
        home.path().to_path_buf(),
        BTreeMap::from([(
            "HARK_HOME".to_string(),
            directory.to_string_lossy().into_owned(),
        )]),
    );
    let id = AgentId::parse("hark").unwrap();
    for api in [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
    ] {
        write_selected_provider(&directory, api, "selected-model");
        let snapshot = provider.read(&id, true).await.unwrap();
        assert_eq!(
            snapshot.authentication,
            agents::AgentAuthenticationStatus::ApiKey
        );
        assert!(snapshot.files.iter().any(|file| file.sensitive));
    }
    std::fs::write(
        directory.join(".credentials.yaml"),
        "version: 1\nrefs:\n  OTHER_API_KEY: unrelated-test-key\n",
    )
    .unwrap();
    assert_eq!(
        provider.read(&id, true).await.unwrap().authentication,
        agents::AgentAuthenticationStatus::NotLoggedIn
    );
    write_selected_provider(&directory, "unsupported-protocol", "selected-model");
    let error = provider.read(&id, false).await.unwrap_err().to_string();
    assert!(error.contains("unsupported api"), "{error}");
    assert!(!error.contains("selected-test-key"));
}

#[test]
fn hark_launch_rereads_native_selection_and_keeps_configuration_unchanged() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".hark/agent");
    let deepseek_directory = home.path().join(".dsh");
    std::fs::create_dir_all(&deepseek_directory).unwrap();
    std::fs::write(
        deepseek_directory.join("settings.yaml"),
        "deepseek: original\n",
    )
    .unwrap();
    let mut env = HashMap::from([
        (
            "HOME".to_string(),
            home.path().to_string_lossy().into_owned(),
        ),
        (
            "HARK_HOME".to_string(),
            directory.to_string_lossy().into_owned(),
        ),
    ]);
    write_selected_provider(&directory, "openai-completions", "first-model");
    agents::apply_hark_native_launch_env(&mut env).unwrap();
    write_selected_provider(&directory, "anthropic-messages", "second-model");
    let credentials = std::fs::read(directory.join(".credentials.yaml")).unwrap();
    let settings = std::fs::read(directory.join("settings.yaml")).unwrap();
    agents::apply_hark_native_launch_env(&mut env).unwrap();
    assert_eq!(
        env.get("DEEPSEEK_ACP_MODEL").map(String::as_str),
        Some("second-model")
    );
    assert_eq!(
        std::fs::read(directory.join(".credentials.yaml")).unwrap(),
        credentials
    );
    assert_eq!(
        std::fs::read(directory.join("settings.yaml")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_to_string(deepseek_directory.join("settings.yaml")).unwrap(),
        "deepseek: original\n"
    );
}

#[test]
fn hark_launch_rejects_missing_or_invalid_configuration_without_an_official_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let mut env = HashMap::from([
        (
            "HARK_HOME".to_string(),
            directory.path().to_string_lossy().into_owned(),
        ),
        (
            "DEEPSEEK_ACP_PROVIDER".to_string(),
            "deepseek-official".to_string(),
        ),
        (
            "DEEPSEEK_API_KEY".to_string(),
            "inherited-test-key".to_string(),
        ),
    ]);
    let error = agents::apply_hark_native_launch_env(&mut env).unwrap_err();
    assert!(error.contains("selected model provider"), "{error}");
    assert!(!env.contains_key("DEEPSEEK_ACP_PROVIDER"));
    assert!(!env.contains_key("DEEPSEEK_API_KEY"));
    std::fs::write(directory.path().join("settings.yaml"), "hark: [").unwrap();
    let error = agents::apply_hark_native_launch_env(&mut env).unwrap_err();
    assert!(error.contains("settings.yaml"), "{error}");
    assert!(!error.contains("inherited-test-key"));
}

#[tokio::test]
async fn hark_public_session_controls_only_offer_configured_models_and_reject_hidden_routes() {
    let home = tempfile::tempdir().unwrap();
    write_selected_provider(home.path(), "openai-completions", "chosen");
    let settings_path = home.path().join("settings.yaml");
    let mut settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["llm-pi-ai"]["providers"]["vibex"]["models"] =
        serde_json::json!([{ "id": "chosen" }, { "id": "second-model" }]);
    std::fs::write(&settings_path, settings.to_string()).unwrap();
    let (event_tx, _event_rx) = agents::manager::manager_event_channel();
    let manager = agents::AgentConnectionManager::new(event_tx);
    let connection_id = agents::AgentConnectionId::new();
    let agent_id = AgentId::parse("hark").unwrap();
    let (_snapshot, ready) = manager
        .register_connection(agents::AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: agents::SessionLaunchLock {
                agent_id,
                absolute_acp_program: std::path::PathBuf::from(env!(
                    "CARGO_BIN_EXE_management_fixture_acp"
                )),
                args: Vec::new(),
                env: BTreeMap::from([("VIBEX_FIXTURE_HARK_MODELS".to_string(), "1".to_string())]),
                runtime_version: "fixture".to_string(),
                acp_version: "fixture".to_string(),
            },
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: home.path().to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: agents::AgentAutoApproveMode::Off,
            env: HashMap::from([(
                "HARK_HOME".to_string(),
                home.path().to_string_lossy().into_owned(),
            )]),
        })
        .await;
    ready.await.unwrap().unwrap();
    let session_id = agents::AgentSessionId::new();
    let (_, controls) = manager
        .prepare_session(
            connection_id,
            session_id,
            agents::SessionControlPreferences {
                config: vec![agents::AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: "deepseek-official::chosen".to_string(),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let model = controls
        .config_options
        .iter()
        .find(|option| option.key == "model")
        .unwrap();
    assert_eq!(
        model
            .choices
            .iter()
            .map(|choice| choice.value.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["vibex::chosen", "vibex::second-model"]
    );
    assert_eq!(model.value, Some(serde_json::json!("vibex::chosen")));
    let reasoning = controls
        .config_options
        .iter()
        .find(|option| option.key == "reasoning")
        .expect("reasoning shares category=model but is not a model selector");
    assert_eq!(reasoning.choices.len(), 2);
    let reasoning_changed = manager
        .set_session_config_option(
            connection_id,
            session_id,
            "reasoning",
            serde_json::json!("high"),
        )
        .await
        .unwrap();
    assert_eq!(
        reasoning_changed
            .config_options
            .iter()
            .find(|option| option.key == "reasoning")
            .unwrap()
            .value,
        Some(serde_json::json!("high"))
    );
    let changed = manager
        .set_session_config_option(
            connection_id,
            session_id,
            "model",
            serde_json::json!("vibex::second-model"),
        )
        .await
        .unwrap();
    let selected = changed
        .config_options
        .iter()
        .find(|option| option.key == "model")
        .unwrap();
    assert_eq!(
        selected.value,
        Some(serde_json::json!("vibex::second-model"))
    );
    for hidden in ["deepseek-official::chosen", "vibex::unconfigured-model"] {
        let unchanged = manager
            .set_session_config_option(
                connection_id,
                session_id,
                "model",
                serde_json::json!(hidden),
            )
            .await
            .unwrap();
        let model = unchanged
            .config_options
            .iter()
            .find(|option| option.key == "model")
            .unwrap();
        assert_eq!(model.value, Some(serde_json::json!("vibex::second-model")));
        assert_eq!(model.choices.len(), 2);
    }
    let error = manager
        .resume_session(connection_id, agents::AgentSessionId::new(), "official-existing", Default::default())
        .await
        .expect_err("an unconfigured restored current model must fail instead of being presented as allowed");
    assert!(error.to_string().contains("Hark"), "{error}");
    manager.disconnect(connection_id).await.unwrap();
}
