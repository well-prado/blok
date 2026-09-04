use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

pub const CONTROL_PLANE_CONTRACT_VERSION: &str = "1";
pub const MAX_CONTROL_PLANE_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
pub const DEFAULT_EVENT_CAPACITY: usize = 256;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicEndpoint {
    pub address: String,
    pub port: u16,
    pub contract_version: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct EndpointCredentials {
    token: String,
}

impl EndpointCredentials {
    pub fn generate() -> Self {
        let bytes: [u8; 32] = rand::random();
        let token = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Self { token }
    }

    fn env(&self, endpoint: &PublicEndpoint) -> Vec<(String, String)> {
        vec![
            (
                "BLOK_CONTROL_PLANE_ADDRESS".to_owned(),
                format!("{}:{}", endpoint.address, endpoint.port),
            ),
            ("BLOK_CONTROL_PLANE_TOKEN".to_owned(), self.token.clone()),
            (
                "BLOK_CONTROL_PLANE_CONTRACT_VERSION".to_owned(),
                endpoint.contract_version.clone(),
            ),
        ]
    }
}

impl fmt::Debug for EndpointCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EndpointCredentials(REDACTED)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlPlaneEndpoint {
    pub public: PublicEndpoint,
    credentials: EndpointCredentials,
}

impl ControlPlaneEndpoint {
    pub fn new(
        address: impl Into<String>,
        port: u16,
        credentials: EndpointCredentials,
    ) -> Result<Self, HostError> {
        let address = address.into();
        validate_loopback_address(&address, port)?;
        if port == 0 {
            return Err(HostError::InvalidEndpoint(
                "control-plane port must be allocated".to_owned(),
            ));
        }
        Ok(Self {
            public: PublicEndpoint {
                address,
                port,
                contract_version: CONTROL_PLANE_CONTRACT_VERSION.to_owned(),
            },
            credentials,
        })
    }

    fn env(&self) -> Vec<(String, String)> {
        self.credentials.env(&self.public)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum UiCommand {
    HostStatus,
    StartSidecar,
    StopSidecar,
    ControlPlane { operation: String, payload: Vec<u8> },
    SubscribeEvents { stream: EventStream },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventStream {
    Model,
    Pty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    InvalidCommand(String),
    InvalidEndpoint(String),
    InvalidProcessSpec(String),
    PayloadTooLarge,
    AlreadyRunning,
    NotRunning,
    ReadinessTimeout,
    SidecarExited(Option<i32>),
    SupervisorFailed(String),
    Process(io::ErrorKind),
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCommand(message) => write!(formatter, "invalid host command: {message}"),
            Self::InvalidEndpoint(message) => {
                write!(formatter, "invalid control-plane endpoint: {message}")
            }
            Self::InvalidProcessSpec(message) => {
                write!(formatter, "invalid sidecar process: {message}")
            }
            Self::PayloadTooLarge => {
                formatter.write_str("control-plane payload exceeds the host limit")
            }
            Self::AlreadyRunning => formatter.write_str("sidecar is already running"),
            Self::NotRunning => formatter.write_str("sidecar is not running"),
            Self::ReadinessTimeout => {
                formatter.write_str("sidecar did not become ready before the startup deadline")
            }
            Self::SidecarExited(code) => {
                write!(formatter, "sidecar exited before readiness (code {code:?})")
            }
            Self::SupervisorFailed(message) => {
                write!(formatter, "sidecar supervision failed: {message}")
            }
            Self::Process(kind) => write!(formatter, "sidecar process error: {kind:?}"),
        }
    }
}

impl std::error::Error for HostError {}

pub fn validate_ui_command(command: &UiCommand) -> Result<(), HostError> {
    match command {
        UiCommand::HostStatus => Ok(()),
        UiCommand::StartSidecar | UiCommand::StopSidecar => Ok(()),
        UiCommand::SubscribeEvents { .. } => Ok(()),
        UiCommand::ControlPlane { operation, payload } => {
            const OPERATIONS: &[&str] = &[
                "create-session",
                "open-session",
                "fork-session",
                "inspect-session",
                "submit-turn",
                "steer-turn",
                "start-workflow",
                "stream-events",
                "answer-interaction",
                "resolve-approval",
                "cancel",
                "resume",
            ];
            if !OPERATIONS.contains(&operation.as_str()) {
                return Err(HostError::InvalidCommand(format!(
                    "operation {operation:?} is not exposed to the WebView"
                )));
            }
            if payload.len() > MAX_CONTROL_PLANE_PAYLOAD_BYTES {
                return Err(HostError::PayloadTooLarge);
            }
            if !payload.is_empty() && serde_json::from_slice::<serde_json::Value>(payload).is_err()
            {
                return Err(HostError::InvalidCommand(
                    "control-plane payload must be valid JSON".to_owned(),
                ));
            }
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReadinessProbe {
    Tcp { port: u16 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestartPolicy {
    pub max_restarts: u32,
    pub min_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 3,
            min_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SidecarSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub endpoint: ControlPlaneEndpoint,
    pub readiness: ReadinessProbe,
    pub extra_env: Vec<(String, String)>,
    pub startup_timeout: Duration,
    pub shutdown_grace: Duration,
    pub restart: RestartPolicy,
}

impl SidecarSpec {
    pub fn validate(&self) -> Result<(), HostError> {
        if self.executable.is_empty()
            || self
                .executable
                .chars()
                .any(|character| character.is_whitespace() || "\0;&|<>`$".contains(character))
        {
            return Err(HostError::InvalidProcessSpec(
                "executable must be a shell-free argv value".to_owned(),
            ));
        }
        if self.args.iter().any(|arg| arg.contains('\0')) {
            return Err(HostError::InvalidProcessSpec(
                "arguments must not contain NUL".to_owned(),
            ));
        }
        let mut names = Vec::<&str>::new();
        for (name, value) in &self.extra_env {
            if name.is_empty()
                || !name.chars().enumerate().all(|(index, character)| {
                    character == '_'
                        || character.is_ascii_alphanumeric()
                            && (index > 0 || character.is_ascii_alphabetic())
                })
            {
                return Err(HostError::InvalidProcessSpec(
                    "environment names must be shell-safe identifiers".to_owned(),
                ));
            }
            if value.contains('\0') || names.iter().any(|existing| *existing == name.as_str()) {
                return Err(HostError::InvalidProcessSpec(
                    "environment entries must be unique and NUL-free".to_owned(),
                ));
            }
            names.push(name.as_str());
        }
        match self.readiness {
            ReadinessProbe::Tcp { port } => {
                validate_loopback_address(&self.endpoint.public.address, port)?
            }
        }
        if self.endpoint.public.port == 0 {
            return Err(HostError::InvalidEndpoint(
                "control-plane port must be non-zero".to_owned(),
            ));
        }
        if matches!(self.readiness, ReadinessProbe::Tcp { port } if port != self.endpoint.public.port)
        {
            return Err(HostError::InvalidEndpoint(
                "readiness must probe the advertised control-plane port".to_owned(),
            ));
        }
        if self.restart.min_backoff > self.restart.max_backoff {
            return Err(HostError::InvalidProcessSpec(
                "minimum backoff cannot exceed maximum backoff".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorState {
    Stopped,
    Starting,
    Ready,
    Backoff,
    Crashed,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostStatus {
    pub state: SupervisorState,
    pub restart_count: u32,
    pub endpoint: Option<PublicEndpoint>,
    pub last_exit_code: Option<i32>,
}

pub struct SidecarSupervisor {
    child: Option<Child>,
    state: SupervisorState,
    restart_count: u32,
    last_exit_code: Option<i32>,
    last_spec: Option<SidecarSpec>,
}

impl Default for SidecarSupervisor {
    fn default() -> Self {
        Self {
            child: None,
            state: SupervisorState::Stopped,
            restart_count: 0,
            last_exit_code: None,
            last_spec: None,
        }
    }
}

impl SidecarSupervisor {
    pub fn status(&mut self) -> HostStatus {
        self.poll();
        HostStatus {
            state: self.state,
            restart_count: self.restart_count,
            endpoint: self
                .last_spec
                .as_ref()
                .map(|spec| spec.endpoint.public.clone()),
            last_exit_code: self.last_exit_code,
        }
    }

    pub fn start(&mut self, spec: SidecarSpec) -> Result<HostStatus, HostError> {
        spec.validate()?;
        if self.child.is_some() {
            return Err(HostError::AlreadyRunning);
        }
        self.last_spec = Some(spec.clone());
        self.state = SupervisorState::Starting;
        self.last_exit_code = None;
        for attempt in 0..=spec.restart.max_restarts {
            if let Err(error) = self.spawn(&spec) {
                self.restart_count = self.restart_count.saturating_add(1);
                if attempt == spec.restart.max_restarts {
                    self.state = SupervisorState::Failed;
                    return Err(error);
                }
                self.state = SupervisorState::Backoff;
                thread::sleep(backoff(spec.restart, attempt));
                continue;
            }
            match self.wait_until_ready(&spec) {
                Ok(()) => {
                    self.state = SupervisorState::Ready;
                    return Ok(self.status());
                }
                Err(error) => {
                    self.kill_child(spec.shutdown_grace);
                    self.last_exit_code = match error {
                        HostError::SidecarExited(code) => code,
                        _ => None,
                    };
                    self.restart_count = self.restart_count.saturating_add(1);
                    if attempt == spec.restart.max_restarts {
                        self.state = SupervisorState::Failed;
                        return Err(error);
                    }
                    self.state = SupervisorState::Backoff;
                    thread::sleep(backoff(spec.restart, attempt));
                }
            }
        }
        Err(HostError::SupervisorFailed(
            "restart loop ended unexpectedly".to_owned(),
        ))
    }

    pub fn restart(&mut self) -> Result<HostStatus, HostError> {
        let spec = self.last_spec.clone().ok_or(HostError::NotRunning)?;
        if self.state == SupervisorState::Crashed {
            self.state = SupervisorState::Backoff;
            thread::sleep(backoff(spec.restart, self.restart_count));
        }
        self.start(spec)
    }

    /// Poll once and restart a crashed sidecar with capped exponential backoff.
    pub fn supervise(&mut self) -> Result<HostStatus, HostError> {
        self.poll();
        if self.state == SupervisorState::Crashed {
            self.restart()
        } else {
            Ok(self.status())
        }
    }

    pub fn poll(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                self.last_exit_code = status.code();
                self.child = None;
                if self.state != SupervisorState::Stopping {
                    self.state = SupervisorState::Crashed;
                }
            }
            Ok(None) => {}
            Err(_) => {
                self.child = None;
                self.state = SupervisorState::Crashed;
            }
        }
    }

    pub fn shutdown(&mut self) -> Result<HostStatus, HostError> {
        if self.child.is_none() {
            self.state = SupervisorState::Stopped;
            return Ok(self.status());
        }
        self.state = SupervisorState::Stopping;
        let grace = self
            .last_spec
            .as_ref()
            .map(|spec| spec.shutdown_grace)
            .unwrap_or(DEFAULT_SHUTDOWN_GRACE);
        self.kill_child(grace);
        self.state = SupervisorState::Stopped;
        Ok(self.status())
    }

    fn spawn(&mut self, spec: &SidecarSpec) -> Result<(), HostError> {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .env_clear()
            .envs(spec.endpoint.env())
            .envs(spec.extra_env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.child = Some(
            command
                .spawn()
                .map_err(|error| HostError::Process(error.kind()))?,
        );
        Ok(())
    }

    fn wait_until_ready(&mut self, spec: &SidecarSpec) -> Result<(), HostError> {
        let deadline = Instant::now()
            + if spec.startup_timeout.is_zero() {
                DEFAULT_STARTUP_TIMEOUT
            } else {
                spec.startup_timeout
            };
        while Instant::now() < deadline {
            self.poll();
            if self.child.is_none() {
                return Err(HostError::SidecarExited(self.last_exit_code));
            }
            let ReadinessProbe::Tcp { port } = spec.readiness;
            let address = format!("{}:{port}", spec.endpoint.public.address);
            if let Ok(mut addresses) = address.to_socket_addrs() {
                if addresses.any(|socket| {
                    TcpStream::connect_timeout(&socket, Duration::from_millis(25)).is_ok()
                }) {
                    return Ok(());
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(HostError::ReadinessTimeout)
    }

    fn kill_child(&mut self, grace: Duration) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        self.kill_child(Duration::from_millis(0));
    }
}

fn backoff(policy: RestartPolicy, attempt: u32) -> Duration {
    let exponent = attempt.min(31);
    let multiplier = 1u128 << exponent;
    let millis = policy.min_backoff.as_millis().saturating_mul(multiplier);
    let capped = millis.min(policy.max_backoff.as_millis());
    Duration::from_millis(capped as u64)
}

fn validate_loopback_address(address: &str, port: u16) -> Result<(), HostError> {
    if port == 0 {
        return Err(HostError::InvalidEndpoint(
            "port must be non-zero".to_owned(),
        ));
    }
    let normalized = address.trim_matches(['[', ']']);
    let is_loopback = normalized == "localhost"
        || normalized
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if !is_loopback {
        return Err(HostError::InvalidEndpoint(
            "endpoint must use localhost or a loopback IP".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum HostEvent {
    Model(Vec<u8>),
    Pty(Vec<u8>),
}

impl HostEvent {
    fn byte_len(&self) -> usize {
        match self {
            Self::Model(data) | Self::Pty(data) => data.len(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SequencedEvent {
    pub sequence: u64,
    pub event: HostEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueResult {
    Queued(u64),
    Backpressure,
    Closed,
}

pub struct OrderedEventChannel {
    capacity: usize,
    next_sequence: u64,
    closed: bool,
    queue: VecDeque<SequencedEvent>,
}

impl OrderedEventChannel {
    pub fn new(capacity: usize) -> Result<Self, HostError> {
        if capacity == 0 {
            return Err(HostError::InvalidCommand(
                "event channel capacity must be positive".to_owned(),
            ));
        }
        Ok(Self {
            capacity,
            next_sequence: 1,
            closed: false,
            queue: VecDeque::with_capacity(capacity),
        })
    }

    pub fn push(&mut self, event: HostEvent) -> EnqueueResult {
        if self.closed {
            return EnqueueResult::Closed;
        }
        if event.byte_len() > MAX_EVENT_BYTES || self.queue.len() == self.capacity {
            return EnqueueResult::Backpressure;
        }
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.queue.push_back(SequencedEvent { sequence, event });
        EnqueueResult::Queued(sequence)
    }

    pub fn pop(&mut self) -> Option<SequencedEvent> {
        self.queue.pop_front()
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }
}

pub struct HostState {
    credentials: EndpointCredentials,
    supervisor: Mutex<SidecarSupervisor>,
    events: Mutex<OrderedEventChannel>,
    sidecar_spec: Mutex<Option<SidecarSpec>>,
}

impl HostState {
    pub fn new() -> Self {
        Self {
            credentials: EndpointCredentials::generate(),
            supervisor: Mutex::new(SidecarSupervisor::default()),
            events: Mutex::new(
                OrderedEventChannel::new(DEFAULT_EVENT_CAPACITY)
                    .expect("default capacity is valid"),
            ),
            sidecar_spec: Mutex::new(None),
        }
    }

    pub fn credentials(&self) -> &EndpointCredentials {
        &self.credentials
    }

    pub fn status(&self) -> Result<HostStatus, HostError> {
        Ok(lock(&self.supervisor)?.status())
    }

    /// Configure the sidecar from trusted host code. The WebView has no command
    /// that accepts an executable path or process arguments.
    pub fn configure_sidecar(&self, mut spec: SidecarSpec) -> Result<(), HostError> {
        spec.endpoint.credentials = self.credentials.clone();
        spec.validate()?;
        *lock(&self.sidecar_spec)? = Some(spec);
        Ok(())
    }

    fn start_sidecar(&self) -> Result<HostStatus, HostError> {
        let spec = lock(&self.sidecar_spec)?.clone().ok_or_else(|| {
            HostError::SupervisorFailed("sidecar is not configured by the trusted host".to_owned())
        })?;
        lock(&self.supervisor)?.start(spec)
    }

    fn stop_sidecar(&self) -> Result<HostStatus, HostError> {
        lock(&self.supervisor)?.shutdown()
    }

    pub fn execute(&self, command: UiCommand) -> Result<HostStatus, HostError> {
        validate_ui_command(&command)?;
        match command {
            UiCommand::HostStatus
            | UiCommand::SubscribeEvents { .. }
            | UiCommand::ControlPlane { .. } => self.status(),
            UiCommand::StartSidecar => self.start_sidecar(),
            UiCommand::StopSidecar => self.stop_sidecar(),
        }
    }

    pub fn enqueue(&self, event: HostEvent) -> Result<EnqueueResult, HostError> {
        Ok(lock(&self.events)?.push(event))
    }

    pub fn drain_events(&self) -> Result<Vec<SequencedEvent>, HostError> {
        let mut events = lock(&self.events)?;
        let mut drained = Vec::with_capacity(events.len());
        while let Some(event) = events.pop() {
            drained.push(event);
        }
        Ok(drained)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, HostError> {
    mutex
        .lock()
        .map_err(|_| HostError::SupervisorFailed("host state lock poisoned".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn endpoint() -> ControlPlaneEndpoint {
        ControlPlaneEndpoint::new("127.0.0.1", 43123, EndpointCredentials::generate())
            .expect("valid endpoint")
    }

    fn spec(port: u16, executable: &str, args: &[&str]) -> SidecarSpec {
        SidecarSpec {
            executable: executable.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            endpoint: ControlPlaneEndpoint::new("127.0.0.1", port, EndpointCredentials::generate())
                .expect("valid endpoint"),
            readiness: ReadinessProbe::Tcp { port },
            extra_env: Vec::new(),
            startup_timeout: Duration::from_millis(80),
            shutdown_grace: Duration::from_millis(50),
            restart: RestartPolicy {
                max_restarts: 2,
                min_backoff: Duration::from_millis(1),
                max_backoff: Duration::from_millis(4),
            },
        }
    }

    #[test]
    fn rejects_public_endpoints_and_does_not_debug_log_the_token() {
        assert!(
            ControlPlaneEndpoint::new("0.0.0.0", 43123, EndpointCredentials::generate()).is_err()
        );
        let credentials = EndpointCredentials::generate();
        assert_eq!(format!("{credentials:?}"), "EndpointCredentials(REDACTED)");
        assert!(!format!("{:?}", endpoint()).contains("BLOK_CONTROL_PLANE_TOKEN"));
    }

    #[test]
    fn validates_only_safe_commands_and_bounds_payloads() {
        assert!(validate_ui_command(&UiCommand::HostStatus).is_ok());
        assert!(validate_ui_command(&UiCommand::StartSidecar).is_ok());
        assert!(validate_ui_command(&UiCommand::ControlPlane {
            operation: "shell.exec".to_owned(),
            payload: Vec::new()
        })
        .is_err());
        assert!(validate_ui_command(&UiCommand::ControlPlane {
            operation: "cancel".to_owned(),
            payload: vec![0; MAX_CONTROL_PLANE_PAYLOAD_BYTES + 1]
        })
        .is_err());
        assert!(validate_ui_command(&UiCommand::ControlPlane {
            operation: "cancel".to_owned(),
            payload: vec![0xff]
        })
        .is_err());
        let parsed: UiCommand = serde_json::from_str(
            r#"{"command":"control_plane","operation":"cancel","payload":[]}"#,
        )
        .expect("known command");
        assert!(validate_ui_command(&parsed).is_ok());
        assert!(serde_json::from_str::<UiCommand>(
            r#"{"command":"raw_shell","command_line":"id"}"#
        )
        .is_err());
    }

    #[test]
    fn keeps_event_order_and_applies_backpressure_without_dropping_sequence() {
        let mut channel = OrderedEventChannel::new(2).expect("capacity");
        assert_eq!(
            channel.push(HostEvent::Model(b"one".to_vec())),
            EnqueueResult::Queued(1)
        );
        assert_eq!(
            channel.push(HostEvent::Pty(b"two".to_vec())),
            EnqueueResult::Queued(2)
        );
        assert_eq!(
            channel.push(HostEvent::Model(b"three".to_vec())),
            EnqueueResult::Backpressure
        );
        assert_eq!(channel.pop().expect("first").sequence, 1);
        assert_eq!(
            channel.push(HostEvent::Model(b"three".to_vec())),
            EnqueueResult::Queued(3)
        );
        assert_eq!(channel.pop().expect("second").sequence, 2);
        assert_eq!(channel.pop().expect("third").sequence, 3);
        assert_eq!(
            channel.push(HostEvent::Model(vec![0; MAX_EVENT_BYTES + 1])),
            EnqueueResult::Backpressure
        );
    }

    #[test]
    fn starts_after_loopback_readiness_and_shuts_down_without_an_orphan() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("address").port();
        let mut supervisor = SidecarSupervisor::default();
        let shell_free = if cfg!(windows) {
            ("cmd", vec!["/C", "ping", "127.0.0.1", "-n", "3"])
        } else {
            ("sleep", vec!["2"])
        };
        let started = supervisor.start(spec(
            port,
            shell_free.0,
            &shell_free.1.iter().map(|arg| *arg).collect::<Vec<_>>(),
        ));
        assert!(
            started.is_ok(),
            "readiness should observe the loopback listener: {started:?}"
        );
        assert_eq!(supervisor.status().state, SupervisorState::Ready);
        assert_eq!(
            supervisor.shutdown().expect("shutdown").state,
            SupervisorState::Stopped
        );
        assert!(supervisor.child.is_none());
        drop(listener);
    }

    #[test]
    fn reports_crash_and_uses_bounded_backoff_when_readiness_never_arrives() {
        let mut sidecar = spec(
            43124,
            if cfg!(windows) { "cmd" } else { "true" },
            if cfg!(windows) {
                &["/C", "exit", "7"]
            } else {
                &[]
            },
        );
        sidecar.restart = RestartPolicy {
            max_restarts: 1,
            min_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(2),
        };
        let mut supervisor = SidecarSupervisor::default();
        let error = supervisor
            .start(sidecar)
            .expect_err("dead sidecar cannot become ready");
        assert!(matches!(
            error,
            HostError::SidecarExited(_) | HostError::ReadinessTimeout
        ));
        assert_eq!(supervisor.status().state, SupervisorState::Failed);
        assert_eq!(supervisor.status().restart_count, 2);
    }

    #[test]
    fn validates_shell_free_process_specs_and_env_isolated_from_ambient_values() {
        let mut sidecar = spec(43125, "node", &["-e", "console.log('ready')"]);
        sidecar.extra_env = vec![("SAFE_NAME".to_owned(), "safe".to_owned())];
        assert!(sidecar.validate().is_ok());
        sidecar.args = vec!["ok\0bad".to_owned()];
        assert!(sidecar.validate().is_err());
        sidecar.args = vec!["ok".to_owned()];
        sidecar.executable = "shell;escape".to_owned();
        assert!(sidecar.validate().is_err());
    }

    #[test]
    fn token_env_is_host_owned_and_not_in_public_endpoint() {
        let credentials = EndpointCredentials::generate();
        let endpoint =
            ControlPlaneEndpoint::new("localhost", 43126, credentials.clone()).expect("endpoint");
        let env = credentials.env(&endpoint.public);
        assert!(env
            .iter()
            .any(|(name, _)| name == "BLOK_CONTROL_PLANE_TOKEN"));
        assert!(!serde_json::to_string(&endpoint.public)
            .expect("public endpoint")
            .contains("token"));
    }
}
