mod host;

pub use host::*;

#[cfg(feature = "tauri-host")]
mod tauri_commands {
    use super::{HostState, HostStatus, SequencedEvent, UiCommand};
    use tauri::{ipc::Channel, State};

    #[tauri::command]
    pub fn host_status(state: State<'_, HostState>) -> Result<HostStatus, String> {
        state.status().map_err(|error| error.to_string())
    }

    #[tauri::command]
    pub fn host_command(
        state: State<'_, HostState>,
        command: UiCommand,
    ) -> Result<HostStatus, String> {
        state.execute(command).map_err(|error| error.to_string())
    }

    #[tauri::command]
    pub fn subscribe_events(
        state: State<'_, HostState>,
        channel: Channel<SequencedEvent>,
    ) -> Result<usize, String> {
        let events = state.drain_events().map_err(|error| error.to_string())?;
        let count = events.len();
        for event in events {
            channel.send(event).map_err(|error| error.to_string())?;
        }
        Ok(count)
    }
}

#[cfg(feature = "tauri-host")]
pub fn run() {
    let state = HostState::new();
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            tauri_commands::host_status,
            tauri_commands::host_command,
            tauri_commands::subscribe_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blok desktop host");
}
