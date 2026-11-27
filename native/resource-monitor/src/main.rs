use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

const PROTOCOL_VERSION: u32 = 2;
const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;
const PROCESS_START_TIME_PRECISION_MS: u64 = 1_000;
const HISTORY_RETENTION_MS: u64 = 60 * 60_000;
const MAX_HISTORY_SNAPSHOTS: usize = 3_600;
const INPUT_QUEUE_CAPACITY: usize = 64;
const MAX_HISTORY_RETAINED_ENTRIES: usize = 20_000;
const MAX_HISTORY_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROCESS_NAME_BYTES: usize = 1_024;
const MAX_PROCESS_COMMAND_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_STATUS_BYTES: usize = 256;
const HISTORY_CHUNK_SNAPSHOTS: usize = 32;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProcess {
    pid: u32,
    #[serde(default)]
    start_time_ms: Option<u64>,
}

impl ExternalProcess {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        #[serde(default)]
        external_processes: Vec<ExternalProcess>,
    },
    SetExternalProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    SetStreaming {
        version: u32,
        enabled: bool,
    },
    SampleNow {
        version: u32,
        request_id: String,
    },
    ReadHistory {
        version: u32,
        request_id: String,
        window_ms: u64,
    },
    Shutdown {
        version: u32,
    },
}

impl Command {
    fn version(&self) -> u32 {
        match self {
            Self::Configure { version, .. }
            | Self::SetExternalProcesses { version, .. }
            | Self::SetSampleInterval { version, .. }
            | Self::SetStreaming { version, .. }
            | Self::SampleNow { version, .. }
            | Self::ReadHistory { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }
}

enum Input {
    Command(Command),
    Invalid(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    cumulative_cpu_time: bool,
    current_cpu_percent: bool,
    resident_memory: bool,
    virtual_memory: bool,
    io_bytes: bool,
    process_start_time: bool,
    process_tree: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sidecar_version: &'static str,
    sidecar_pid: u32,
    platform: &'static str,
    arch: &'static str,
    capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    ppid: u32,
    start_time_ms: u64,
    run_time_ms: u64,
    name: String,
    command: String,
    status: String,
    cpu_percent: f32,
    cpu_time_ms: u64,
    resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_semantics: IoSemantics,
}

impl ProcessSample {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.name.len())
            .saturating_add(self.command.len())
            .saturating_add(self.status.len())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sequence: u64,
    sampled_at_unix_ms: u64,
    collection_duration_micros: u64,
    scanned_process_count: usize,
    retained_process_count: usize,
    inaccessible_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    external_processes: Vec<ExternalProcess>,
    processes: Vec<ProcessSample>,
}

impl SnapshotEvent {
    fn retained_entry_count(&self) -> usize {
        self.processes
            .len()
            .saturating_add(self.external_processes.len())
    }

    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(
                self.processes
                    .iter()
                    .map(ProcessSample::estimated_history_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.external_processes
                    .iter()
                    .map(ExternalProcess::estimated_history_bytes)
                    .sum::<usize>(),
            )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChunkEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    done: bool,
    snapshots: &'a [SnapshotEvent],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    code: &'static str,
    message: String,
    recoverable: bool,
}

#[derive(Debug, Clone)]
struct CollectorConfig {
    root_pid: u32,
    sample_interval: Option<Duration>,
    external_processes: HashMap<u32, Option<u64>>,
}

#[derive(Default)]
struct HistoryRecorder {
    snapshots: VecDeque<SnapshotEvent>,
    retained_entry_count: usize,
    retained_bytes: usize,
}

impl HistoryRecorder {
    fn record(&mut self, snapshot: &SnapshotEvent) {
        self.record_with_limits(
            snapshot,
            MAX_HISTORY_SNAPSHOTS,
            MAX_HISTORY_RETAINED_ENTRIES,
            MAX_HISTORY_RETAINED_BYTES,
        );
    }

    fn record_with_limits(
        &mut self,
        snapshot: &SnapshotEvent,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let mut retained = snapshot.clone();
        retained.request_id = None;
        self.retained_entry_count = self
            .retained_entry_count
            .saturating_add(retained.retained_entry_count());
        self.retained_bytes = self
            .retained_bytes
            .saturating_add(retained.estimated_history_bytes());
        self.snapshots.push_back(retained);
        self.trim_to_limits(
            snapshot.sampled_at_unix_ms,
            max_snapshots,
            max_retained_entries,
            max_retained_bytes,
        );
    }

    fn trim_to_limits(
        &mut self,
        now_ms: u64,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let mut future_entry_count = 0usize;
        let mut future_bytes = 0usize;
        self.snapshots.retain(|snapshot| {
            let keep = snapshot.sampled_at_unix_ms <= now_ms;
            if !keep {
                future_entry_count =
                    future_entry_count.saturating_add(snapshot.retained_entry_count());
                future_bytes = future_bytes.saturating_add(snapshot.estimated_history_bytes());
            }
            keep
        });
        self.retained_entry_count = self.retained_entry_count.saturating_sub(future_entry_count);
        self.retained_bytes = self.retained_bytes.saturating_sub(future_bytes);

        while self.snapshots.front().is_some_and(|snapshot| {
            snapshot.sampled_at_unix_ms < now_ms.saturating_sub(HISTORY_RETENTION_MS)
                || self.snapshots.len() > max_snapshots
                || self.retained_entry_count > max_retained_entries
                || self.retained_bytes > max_retained_bytes
        }) {
            if let Some(removed) = self.snapshots.pop_front() {
                self.retained_entry_count = self
                    .retained_entry_count
                    .saturating_sub(removed.retained_entry_count());
                self.retained_bytes = self
                    .retained_bytes
                    .saturating_sub(removed.estimated_history_bytes());
            }
        }
    }

    fn read(&self, window_ms: u64, now_ms: u64) -> Vec<SnapshotEvent> {
        let started_at_ms = now_ms.saturating_sub(window_ms.min(HISTORY_RETENTION_MS));
        self.snapshots
            .iter()
            .filter(|snapshot| {
                snapshot.sampled_at_unix_ms >= started_at_ms
                    && snapshot.sampled_at_unix_ms <= now_ms
            })
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone)]
struct CachedProcessMetadata {
    name: String,
    command: String,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WinProcessRow {
    pid: u32,
    ppid: u32,
    start_time_ms: u64,
    name: String,
    cpu_time_ms: u64,
    resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
}

#[cfg(target_os = "windows")]
fn windows_filetime_to_unix_ms(filetime_100ns: i64) -> u64 {
    if filetime_100ns <= 0 {
        return 0;
    }
    const WINDOWS_TO_UNIX_EPOCH_SECS: u64 = 11_644_473_600;
    let secs = (filetime_100ns as u64) / 10_000_000;
    secs.saturating_sub(WINDOWS_TO_UNIX_EPOCH_SECS)
        .saturating_mul(1_000)
}

#[cfg(target_os = "windows")]
fn query_windows_process_table(buffer: &mut Vec<u8>) -> Option<Vec<WinProcessRow>> {
    use ntapi::ntexapi::{NtQuerySystemInformation, SYSTEM_PROCESS_INFORMATION, SystemProcessInformation};
    use winapi::shared::ntstatus::STATUS_INFO_LENGTH_MISMATCH;

    if buffer.len() < 512 * 1024 {
        buffer.resize(512 * 1024, 0);
    }

    let mut return_length: u32 = 0;
    loop {
        let status = unsafe {
            NtQuerySystemInformation(
                SystemProcessInformation,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut return_length,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            let needed = (return_length as usize).max(buffer.len().saturating_mul(2));
            let target = needed.saturating_add(128 * 1024);
            if target > 64 * 1024 * 1024 {
                return None;
            }
            buffer.resize(target, 0);
            continue;
        }
        if status < 0 {
            return None;
        }
        break;
    }

    let mut rows = Vec::with_capacity(512);
    let mut offset = 0usize;
    let entry_size = std::mem::size_of::<SYSTEM_PROCESS_INFORMATION>();
    while offset.saturating_add(entry_size) <= buffer.len() {
        let info = unsafe { &*(buffer.as_ptr().add(offset) as *const SYSTEM_PROCESS_INFORMATION) };
        let pid = info.UniqueProcessId as usize as u32;
        let ppid = info.InheritedFromUniqueProcessId as usize as u32;
        let create_time = unsafe { *info.CreateTime.QuadPart() };
        let user_time = unsafe { *info.UserTime.QuadPart() };
        let kernel_time = unsafe { *info.KernelTime.QuadPart() };
        let read_bytes = unsafe { *info.ReadTransferCount.QuadPart() };
        let write_bytes = unsafe { *info.WriteTransferCount.QuadPart() };

        let name = if !info.ImageName.Buffer.is_null() && info.ImageName.Length > 0 {
            let len_u16 = (info.ImageName.Length as usize) / 2;
            let slice = unsafe { std::slice::from_raw_parts(info.ImageName.Buffer, len_u16) };
            String::from_utf16_lossy(slice)
        } else if pid == 0 {
            "System Idle Process".to_owned()
        } else {
            String::new()
        };

        let cpu_100ns = (user_time.max(0) as u64).saturating_add(kernel_time.max(0) as u64);
        rows.push(WinProcessRow {
            pid,
            ppid,
            start_time_ms: windows_filetime_to_unix_ms(create_time),
            name,
            cpu_time_ms: cpu_100ns / 10_000,
            resident_bytes: info.WorkingSetSize as u64,
            virtual_bytes: info.PrivatePageCount as u64,
            io_read_bytes: read_bytes.max(0) as u64,
            io_write_bytes: write_bytes.max(0) as u64,
        });

        if info.NextEntryOffset == 0 {
            break;
        }
        offset = offset.saturating_add(info.NextEntryOffset as usize);
    }

    Some(rows)
}

struct Collector {
    system: System,
    sequence: u64,
    cpu_baseline_refreshed_at: Option<Instant>,
    metadata_cache: HashMap<(u32, u64), CachedProcessMetadata>,
    #[cfg(target_os = "windows")]
    win_query_buffer: Vec<u8>,
    #[cfg(target_os = "windows")]
    win_cpu_baseline: HashMap<(u32, u64), (u64, Instant)>,
}

impl Collector {
    fn new() -> Self {
        Self {
            system: System::new(),
            sequence: 0,
            cpu_baseline_refreshed_at: None,
            metadata_cache: HashMap::new(),
            #[cfg(target_os = "windows")]
            win_query_buffer: Vec::new(),
            #[cfg(target_os = "windows")]
            win_cpu_baseline: HashMap::new(),
        }
    }

    #[cfg(target_os = "windows")]
    fn prime_cpu_usage(&mut self, config: &CollectorConfig) {
        if let Some(win_rows) = query_windows_process_table(&mut self.win_query_buffer) {
            let now = Instant::now();
            let rows = win_rows
                .iter()
                .map(|row| (row.pid, row.ppid, row.start_time_ms))
                .collect::<Vec<_>>();
            let start_time_by_pid = rows
                .iter()
                .map(|(pid, _, start_time_ms)| (*pid, *start_time_ms))
                .collect::<HashMap<_, _>>();
            let mut roots = config
                .external_processes
                .iter()
                .filter_map(|(pid, expected_start_time_ms)| {
                    let actual_start_time_ms = *start_time_by_pid.get(pid)?;
                    matches_external_identity(actual_start_time_ms, *expected_start_time_ms)
                        .then_some(*pid)
                })
                .collect::<HashSet<_>>();
            roots.insert(config.root_pid);
            let tracked = select_tracked_pids(&rows, &roots);
            self.win_cpu_baseline.clear();
            for row in win_rows {
                if tracked.contains(&row.pid) {
                    self.win_cpu_baseline
                        .insert((row.pid, row.start_time_ms), (row.cpu_time_ms, now));
                }
            }
            self.cpu_baseline_refreshed_at = Some(now);
            return;
        }
        let (_, _, tracked) = self.discover_tracked_processes(config);
        self.refresh_tracked_details(&tracked, false);
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    #[cfg(not(target_os = "windows"))]
    fn prime_cpu_usage(&mut self, config: &CollectorConfig) {
        let (_, _, tracked) = self.discover_tracked_processes(config);
        self.refresh_tracked_details(&tracked, false);
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    #[cfg(target_os = "windows")]
    fn sample_windows_fast(
        &mut self,
        config: &CollectorConfig,
        request_id: Option<String>,
        collection_started: Instant,
    ) -> Option<SnapshotEvent> {
        let win_rows = query_windows_process_table(&mut self.win_query_buffer)?;
        let sampled_instant = Instant::now();
        let now_unix_ms = unix_time_ms();
        let scanned_process_count = win_rows.len();

        let rows = win_rows
            .iter()
            .map(|row| (row.pid, row.ppid, row.start_time_ms))
            .collect::<Vec<_>>();
        let by_pid = win_rows
            .into_iter()
            .map(|row| (row.pid, row))
            .collect::<HashMap<_, _>>();

        let external_processes = config
            .external_processes
            .iter()
            .filter_map(|(pid, expected_start_time_ms)| {
                let actual_start_time_ms = by_pid.get(pid)?.start_time_ms;
                matches_external_identity(actual_start_time_ms, *expected_start_time_ms).then_some(
                    ExternalProcess {
                        pid: *pid,
                        start_time_ms: Some(actual_start_time_ms),
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut roots = external_processes
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots);
        let tracked_process_count = tracked.len();

        let active_identities = tracked
            .iter()
            .filter_map(|pid| by_pid.get(pid).map(|row| (*pid, row.start_time_ms)))
            .collect::<HashSet<_>>();
        prune_metadata_cache(&mut self.metadata_cache, &active_identities);
        self.win_cpu_baseline
            .retain(|identity, _| active_identities.contains(identity));

        let pids_needing_cmd = active_identities
            .iter()
            .filter(|identity| !self.metadata_cache.contains_key(identity))
            .map(|(pid, _)| Pid::from_u32(*pid))
            .collect::<Vec<_>>();
        if !pids_needing_cmd.is_empty() {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids_needing_cmd),
                false,
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::Always)
                    .without_tasks(),
            );
        }

        let mut processes = tracked
            .into_iter()
            .filter_map(|pid| {
                let row = by_pid.get(&pid)?;
                let identity = (pid, row.start_time_ms);
                let metadata = self.metadata_cache.entry(identity).or_insert_with(|| {
                    let name = truncate_utf8(row.name.clone(), MAX_PROCESS_NAME_BYTES);
                    let sys_cmd = self
                        .system
                        .process(Pid::from_u32(pid))
                        .map(|process| process.cmd())
                        .unwrap_or(&[]);
                    let command = if sys_cmd.is_empty() {
                        name.clone()
                    } else {
                        truncate_utf8(
                            sys_cmd
                                .iter()
                                .map(|part| part.to_string_lossy())
                                .collect::<Vec<_>>()
                                .join(" "),
                            MAX_PROCESS_COMMAND_BYTES,
                        )
                    };
                    CachedProcessMetadata { name, command }
                });

                let cpu_percent = self
                    .win_cpu_baseline
                    .insert(identity, (row.cpu_time_ms, sampled_instant))
                    .map(|(prev_cpu_ms, prev_instant)| {
                        let elapsed_ms = sampled_instant
                            .saturating_duration_since(prev_instant)
                            .as_secs_f64()
                            * 1_000.0;
                        if elapsed_ms <= 0.0 || row.cpu_time_ms < prev_cpu_ms {
                            0.0
                        } else {
                            (((row.cpu_time_ms - prev_cpu_ms) as f64 / elapsed_ms) * 100.0) as f32
                        }
                    })
                    .unwrap_or(0.0);

                Some(ProcessSample {
                    pid,
                    ppid: row.ppid,
                    start_time_ms: row.start_time_ms,
                    run_time_ms: now_unix_ms.saturating_sub(row.start_time_ms),
                    name: metadata.name.clone(),
                    command: metadata.command.clone(),
                    status: "Run".to_owned(),
                    cpu_percent,
                    cpu_time_ms: row.cpu_time_ms,
                    resident_bytes: row.resident_bytes,
                    virtual_bytes: row.virtual_bytes,
                    io_read_bytes: row.io_read_bytes,
                    io_write_bytes: row.io_write_bytes,
                    io_semantics: io_semantics(),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);
        self.cpu_baseline_refreshed_at = Some(sampled_instant);

        Some(SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: now_unix_ms,
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count,
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
        })
    }

    fn discover_tracked_processes(
        &mut self,
        config: &CollectorConfig,
    ) -> (usize, Vec<ExternalProcess>, Vec<(u32, u64)>) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            discovery_refresh_kind(),
        );
        let scanned_process_count = self.system.processes().len();

        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                let ppid = process.parent().map(Pid::as_u32).unwrap_or(0);
                (pid, ppid, process.start_time().saturating_mul(1_000))
            })
            .collect::<Vec<_>>();
        let start_time_by_pid = rows
            .iter()
            .map(|(pid, _, start_time_ms)| (*pid, *start_time_ms))
            .collect::<HashMap<_, _>>();
        let external_processes = config
            .external_processes
            .iter()
            .filter_map(|(pid, expected_start_time_ms)| {
                let actual_start_time_ms = *start_time_by_pid.get(pid)?;
                matches_external_identity(actual_start_time_ms, *expected_start_time_ms).then_some(
                    ExternalProcess {
                        pid: *pid,
                        start_time_ms: Some(actual_start_time_ms),
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut roots = external_processes
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots)
            .into_iter()
            .filter_map(|pid| start_time_by_pid.get(&pid).map(|start| (pid, *start)))
            .collect::<Vec<_>>();

        (scanned_process_count, external_processes, tracked)
    }

    fn refresh_tracked_details(&mut self, tracked: &[(u32, u64)], refresh_metadata: bool) {
        let mut pids_with_cmd = Vec::new();
        let mut pids_metrics_only = Vec::new();

        for &(pid, start_time_ms) in tracked {
            let pid_handle = Pid::from_u32(pid);
            if refresh_metadata && !self.metadata_cache.contains_key(&(pid, start_time_ms)) {
                pids_with_cmd.push(pid_handle);
            } else {
                pids_metrics_only.push(pid_handle);
            }
        }

        if !pids_with_cmd.is_empty() {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids_with_cmd),
                false,
                detail_refresh_kind(true),
            );
        }
        if !pids_metrics_only.is_empty() {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids_metrics_only),
                false,
                detail_refresh_kind(false),
            );
        }
    }

    fn sample(&mut self, config: &CollectorConfig, request_id: Option<String>) -> SnapshotEvent {
        if let Some(delay) =
            remaining_cpu_measurement_delay(self.cpu_baseline_refreshed_at.take(), Instant::now())
        {
            thread::sleep(delay);
        }
        let collection_started = Instant::now();
        #[cfg(target_os = "windows")]
        if let Some(event) = self.sample_windows_fast(config, request_id.clone(), collection_started)
        {
            return event;
        }
        let (scanned_process_count, external_processes, tracked) =
            self.discover_tracked_processes(config);
        let tracked_process_count = tracked.len();
        self.refresh_tracked_details(&tracked, true);
        self.cpu_baseline_refreshed_at = Some(Instant::now());

        let active_identities = tracked.iter().copied().collect::<HashSet<_>>();
        prune_metadata_cache(&mut self.metadata_cache, &active_identities);

        let mut processes = tracked
            .into_iter()
            .filter_map(|(pid, start_time_ms)| {
                let process = self.system.process(Pid::from_u32(pid))?;
                let disk_usage = process.disk_usage();
                let metadata = self
                    .metadata_cache
                    .entry((pid, start_time_ms))
                    .or_insert_with(|| {
                        let name = truncate_utf8(
                            process.name().to_string_lossy().into_owned(),
                            MAX_PROCESS_NAME_BYTES,
                        );
                        let command = if process.cmd().is_empty() {
                            name.clone()
                        } else {
                            truncate_utf8(
                                process
                                    .cmd()
                                    .iter()
                                    .map(|part| part.to_string_lossy())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                                MAX_PROCESS_COMMAND_BYTES,
                            )
                        };
                        CachedProcessMetadata { name, command }
                    });

                Some(ProcessSample {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    start_time_ms,
                    run_time_ms: process.run_time().saturating_mul(1_000),
                    name: metadata.name.clone(),
                    command: metadata.command.clone(),
                    status: truncate_utf8(
                        format!("{:?}", process.status()),
                        MAX_PROCESS_STATUS_BYTES,
                    ),
                    cpu_percent: process.cpu_usage(),
                    cpu_time_ms: process.accumulated_cpu_time(),
                    resident_bytes: process.memory(),
                    virtual_bytes: process.virtual_memory(),
                    io_read_bytes: disk_usage.total_read_bytes,
                    io_write_bytes: disk_usage.total_written_bytes,
                    io_semantics: io_semantics(),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);

        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: unix_time_ms(),
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count,
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
        }
    }
}

fn discovery_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing().without_tasks()
}

fn detail_refresh_kind(include_cmd: bool) -> ProcessRefreshKind {
    let base = ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .without_tasks();
    if include_cmd {
        base.with_cmd(UpdateKind::Always)
    } else {
        base
    }
}

#[cfg(test)]
fn process_refresh_kind() -> ProcessRefreshKind {
    detail_refresh_kind(true)
}

fn prune_metadata_cache(
    cache: &mut HashMap<(u32, u64), CachedProcessMetadata>,
    active_identities: &HashSet<(u32, u64)>,
) {
    cache.retain(|identity, _| active_identities.contains(identity));
}

fn inaccessible_process_count(selected: usize, materialized: usize) -> usize {
    selected.saturating_sub(materialized)
}

fn remaining_cpu_measurement_delay(
    baseline_refreshed_at: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    baseline_refreshed_at
        .and_then(|baseline| MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(now.duration_since(baseline)))
        .filter(|delay| !delay.is_zero())
}

fn matches_external_identity(
    actual_start_time_ms: u64,
    expected_start_time_ms: Option<u64>,
) -> bool {
    // sysinfo reports process starts at whole-second precision. Normalize the
    // higher-resolution Electron timestamp to that same bucket instead of
    // accepting adjacent seconds, which could attach a quickly reused PID.
    expected_start_time_ms.is_none_or(|expected| {
        actual_start_time_ms == expected - (expected % PROCESS_START_TIME_PRECISION_MS)
    })
}

fn select_tracked_pids(rows: &[(u32, u32, u64)], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<(u32, u64)>>::new();
    let mut start_time_by_pid = HashMap::<u32, u64>::new();
    for (pid, ppid, start_time_ms) in rows {
        children_by_parent
            .entry(*ppid)
            .or_default()
            .push((*pid, *start_time_ms));
        start_time_by_pid.insert(*pid, *start_time_ms);
    }

    let mut tracked = HashSet::new();
    let mut visited_identities = HashSet::new();
    let mut queue = roots
        .iter()
        .filter_map(|pid| {
            start_time_by_pid
                .get(pid)
                .map(|start_time_ms| (*pid, *start_time_ms))
        })
        .collect::<VecDeque<_>>();

    while let Some((pid, start_time_ms)) = queue.pop_front() {
        if !visited_identities.insert((pid, start_time_ms)) {
            continue;
        }
        tracked.insert(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(
                children
                    .iter()
                    .copied()
                    .filter(|(_, child_start_time_ms)| *child_start_time_ms >= start_time_ms),
            );
        }
    }

    tracked
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    value
}

fn io_semantics() -> IoSemantics {
    if cfg!(target_os = "windows") {
        IoSemantics::AllIo
    } else {
        IoSemantics::Storage
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clamp_sample_interval(sample_interval_ms: u64) -> Option<Duration> {
    (sample_interval_ms > 0).then(|| {
        Duration::from_millis(
            sample_interval_ms.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS),
        )
    })
}

fn spawn_input_reader() -> Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(Input::Invalid(format!(
                        "failed reading command stream: {error}"
                    )));
                    return;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if sender.send(Input::Command(command)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    if sender
                        .send(Input::Invalid(format!("invalid command: {error}")))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

fn sample_now_deadline(
    current: Option<Instant>,
    interval: Option<Duration>,
    now: Instant,
) -> Option<Instant> {
    current.or_else(|| interval.map(|duration| now + duration))
}

fn write_event<T: Serialize>(writer: &mut impl Write, event: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_error(
    writer: &mut impl Write,
    code: &'static str,
    message: impl Into<String>,
    recoverable: bool,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            code,
            message: message.into(),
            recoverable,
        },
    )
}

fn write_history(
    writer: &mut impl Write,
    request_id: &str,
    snapshots: &[SnapshotEvent],
) -> io::Result<()> {
    if snapshots.is_empty() {
        return write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: true,
                snapshots,
            },
        );
    }

    let chunk_count = snapshots.len().div_ceil(HISTORY_CHUNK_SNAPSHOTS);
    for (index, chunk) in snapshots.chunks(HISTORY_CHUNK_SNAPSHOTS).enumerate() {
        write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: index + 1 == chunk_count,
                snapshots: chunk,
            },
        )?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let mut writer = BufWriter::new(io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                cumulative_cpu_time: true,
                current_cpu_percent: true,
                resident_memory: true,
                virtual_memory: true,
                io_bytes: true,
                process_start_time: true,
                process_tree: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut collector = Collector::new();
    let mut history = HistoryRecorder::default();
    let mut config: Option<CollectorConfig> = None;
    let mut next_sample_at: Option<Instant> = None;
    let mut streaming_enabled = false;

    loop {
        if next_sample_at.is_some_and(|deadline| deadline <= Instant::now()) {
            if let Some(current) = config.as_ref() {
                if let Some(interval) = current.sample_interval {
                    let event = collector.sample(current, None);
                    history.record(&event);
                    if streaming_enabled {
                        write_event(&mut writer, &event)?;
                    }
                    next_sample_at = Some(Instant::now() + interval);
                } else {
                    next_sample_at = None;
                }
            } else {
                next_sample_at = None;
            }
            continue;
        }

        let timeout = next_sample_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));

        match receiver.recv_timeout(timeout) {
            Ok(Input::Invalid(message)) => {
                write_error(&mut writer, "invalid-command", message, true)?;
            }
            Ok(Input::Command(command)) => {
                if command.version() != PROTOCOL_VERSION {
                    write_error(
                        &mut writer,
                        "protocol-mismatch",
                        format!(
                            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                            command.version()
                        ),
                        false,
                    )?;
                    continue;
                }

                match command {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        external_processes,
                        ..
                    } => {
                        let sample_interval = clamp_sample_interval(sample_interval_ms);
                        let next_config = CollectorConfig {
                            root_pid,
                            sample_interval,
                            external_processes: external_processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect(),
                        };
                        collector.prime_cpu_usage(&next_config);
                        config = Some(next_config);
                        next_sample_at = sample_interval.map(|_| Instant::now());
                    }
                    Command::SetExternalProcesses { processes, .. } => {
                        if let Some(current) = config.as_mut() {
                            current.external_processes = processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect();
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before external processes",
                                true,
                            )?;
                        }
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        if let Some(current) = config.as_mut() {
                            current.sample_interval = clamp_sample_interval(sample_interval_ms);
                            next_sample_at = current
                                .sample_interval
                                .map(|interval| Instant::now() + interval);
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before changing the sample interval",
                                true,
                            )?;
                        }
                    }
                    Command::SetStreaming { enabled, .. } => {
                        streaming_enabled = enabled;
                    }
                    Command::SampleNow { request_id, .. } => {
                        if let Some(current) = config.as_ref() {
                            let event = collector.sample(current, Some(request_id));
                            history.record(&event);
                            write_event(&mut writer, &event)?;
                            next_sample_at = sample_now_deadline(
                                next_sample_at,
                                current.sample_interval,
                                Instant::now(),
                            );
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before sampling",
                                true,
                            )?;
                        }
                    }
                    Command::ReadHistory {
                        request_id,
                        window_ms,
                        ..
                    } => {
                        if config.is_some() {
                            let snapshots = history.read(window_ms, unix_time_ms());
                            write_history(&mut writer, &request_id, &snapshots)?;
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before reading history",
                                true,
                            )?;
                        }
                    }
                    Command::Shutdown { .. } => return Ok(()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_roots_and_all_descendants() {
        let rows = vec![
            (10, 1, 1_000),
            (11, 10, 1_100),
            (12, 11, 1_200),
            (20, 1, 2_000),
            (21, 20, 2_100),
            (30, 99, 3_000),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([10, 20]));

        assert_eq!(tracked, HashSet::from([10, 11, 12, 20, 21]));
    }

    #[test]
    fn rejects_descendants_older_than_a_reused_parent_pid() {
        let rows = vec![
            (20, 1, 5_000),
            (21, 20, 4_000),
            (22, 20, 5_100),
            (23, 21, 5_200),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([20]));

        assert_eq!(tracked, HashSet::from([20, 22]));
    }

    #[test]
    fn ignores_missing_roots() {
        let rows = vec![(10, 1, 1_000), (11, 10, 1_100)];
        let tracked = select_tracked_pids(&rows, &HashSet::from([99]));

        assert!(tracked.is_empty());
    }

    #[test]
    fn validates_external_process_start_identity() {
        assert!(matches_external_identity(10_000, None));
        assert!(matches_external_identity(10_000, Some(10_999)));
        assert!(!matches_external_identity(10_000, Some(11_000)));
        assert!(!matches_external_identity(10_000, Some(9_999)));
    }

    #[test]
    fn decodes_protocol_commands() {
        let configure = serde_json::from_str::<Command>(
            r#"{"version":2,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"externalProcesses":[{"pid":7}]}"#,
        )
        .expect("configure command");

        match configure {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                external_processes,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1_000);
                assert_eq!(external_processes[0].pid, 7);
                assert_eq!(external_processes[0].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let read_history = serde_json::from_str::<Command>(
            r#"{"version":2,"type":"readHistory","requestId":"history-1","windowMs":60000}"#,
        )
        .expect("read history command");
        assert!(matches!(
            read_history,
            Command::ReadHistory {
                request_id,
                window_ms: 60_000,
                ..
            } if request_id == "history-1"
        ));
    }

    #[test]
    fn clamps_sample_interval() {
        assert_eq!(clamp_sample_interval(0), None);
        assert_eq!(clamp_sample_interval(1), Some(Duration::from_millis(250)));
        assert_eq!(
            clamp_sample_interval(100_000),
            Some(Duration::from_millis(60_000))
        );
    }

    #[test]
    fn counts_selected_processes_that_could_not_be_materialized() {
        assert_eq!(inaccessible_process_count(5, 3), 2);
        assert_eq!(inaccessible_process_count(3, 5), 0);
    }

    #[test]
    fn waits_for_a_cpu_measurement_window_after_priming() {
        let baseline = Instant::now();

        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline),
            Some(MINIMUM_CPU_UPDATE_INTERVAL)
        );
        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline + MINIMUM_CPU_UPDATE_INTERVAL),
            None
        );
        assert_eq!(remaining_cpu_measurement_delay(None, baseline), None);
    }

    #[test]
    fn retains_bounded_history_without_request_ids() {
        let mut history = HistoryRecorder::default();
        for sequence in 0..=MAX_HISTORY_SNAPSHOTS {
            history.record(&SnapshotEvent {
                version: PROTOCOL_VERSION,
                event_type: "snapshot",
                sequence: sequence as u64,
                sampled_at_unix_ms: sequence as u64 * 1_000,
                collection_duration_micros: 1,
                scanned_process_count: 0,
                retained_process_count: 0,
                inaccessible_process_count: 0,
                request_id: Some("request".to_owned()),
                external_processes: vec![ExternalProcess {
                    pid: 7,
                    start_time_ms: Some(1_000),
                }],
                processes: Vec::new(),
            });
        }

        assert_eq!(history.snapshots.len(), MAX_HISTORY_SNAPSHOTS);
        assert!(
            history
                .snapshots
                .iter()
                .all(|snapshot| snapshot.request_id.is_none())
        );
        assert!(history.snapshots.iter().all(|snapshot| {
            snapshot.external_processes.len() == 1
                && snapshot.external_processes[0].pid == 7
                && snapshot.external_processes[0].start_time_ms == Some(1_000)
        }));
        assert_eq!(
            history
                .read(10_000, MAX_HISTORY_SNAPSHOTS as u64 * 1_000)
                .len(),
            11
        );
    }

    #[test]
    fn excludes_and_trims_future_history_after_the_clock_moves_backward() {
        let mut history = HistoryRecorder::default();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 2_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
        };
        history.record(&snapshot);

        assert!(history.read(0, 1_000).is_empty());

        history.record(&SnapshotEvent {
            sequence: 2,
            sampled_at_unix_ms: 1_000,
            ..snapshot
        });
        assert_eq!(history.snapshots.len(), 1);
        assert_eq!(
            history.snapshots.front().map(|entry| entry.sequence),
            Some(2)
        );
    }

    #[test]
    fn bounds_history_by_estimated_process_bytes() {
        let mut history = HistoryRecorder::default();
        let command = "x".repeat(128);
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot_bytes =
            std::mem::size_of::<SnapshotEvent>() + process.estimated_history_bytes();
        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    version: PROTOCOL_VERSION,
                    event_type: "snapshot",
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    collection_duration_micros: 1,
                    scanned_process_count: 1,
                    retained_process_count: 1,
                    inaccessible_process_count: 0,
                    request_id: None,
                    external_processes: Vec::new(),
                    processes: vec![ProcessSample {
                        pid: sequence as u32 + 1,
                        start_time_ms: sequence * 1_000,
                        ..process.clone()
                    }],
                },
                3,
                3,
                snapshot_bytes * 2,
            );
        }

        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn counts_external_processes_toward_history_limits() {
        let mut history = HistoryRecorder::default();
        let external_processes = (1..=128)
            .map(|pid| ExternalProcess {
                pid,
                start_time_ms: Some(u64::from(pid) * 1_000),
            })
            .collect::<Vec<_>>();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 0,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes,
            processes: Vec::new(),
        };
        let snapshot_bytes = snapshot.estimated_history_bytes();
        let snapshot_entries = snapshot.retained_entry_count();

        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    ..snapshot.clone()
                },
                3,
                snapshot_entries * 2,
                snapshot_bytes * 2,
            );
        }

        assert_eq!(history.retained_entry_count, snapshot_entries * 2);
        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn truncates_process_strings_at_utf8_boundaries() {
        let value = "é".repeat(MAX_PROCESS_NAME_BYTES);
        let truncated = truncate_utf8(value, MAX_PROCESS_NAME_BYTES - 1);

        assert!(truncated.len() < MAX_PROCESS_NAME_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn refreshes_commands_without_enumerating_linux_tasks() {
        let discovery = discovery_refresh_kind();
        assert!(!discovery.tasks());
        assert!(!discovery.cpu());
        assert!(!discovery.memory());
        assert!(!discovery.disk_usage());
        assert_eq!(discovery.cmd(), UpdateKind::Never);

        let metrics_only = detail_refresh_kind(false);
        assert!(!metrics_only.tasks());
        assert!(metrics_only.cpu());
        assert!(metrics_only.memory());
        assert!(metrics_only.disk_usage());
        assert_eq!(metrics_only.cmd(), UpdateKind::Never);

        let refresh_kind = process_refresh_kind();
        assert_eq!(refresh_kind.cmd(), UpdateKind::Always);
        assert!(!refresh_kind.tasks());
        assert!(refresh_kind.cpu());
        assert!(refresh_kind.memory());
        assert!(refresh_kind.disk_usage());
    }

    #[test]
    fn prunes_dead_entries_from_metadata_cache_by_pid_and_start_time() {
        let mut cache = HashMap::new();
        cache.insert(
            (100, 1_000),
            CachedProcessMetadata {
                name: "node.exe".to_owned(),
                command: "node server.js".to_owned(),
            },
        );
        cache.insert(
            (200, 2_000),
            CachedProcessMetadata {
                name: "agy.exe".to_owned(),
                command: "agy acp".to_owned(),
            },
        );
        // Reused PID 200 with a newer start_time_ms must invalidate the old entry.
        let active = HashSet::from([(100, 1_000), (200, 5_000)]);
        prune_metadata_cache(&mut cache, &active);

        assert!(cache.contains_key(&(100, 1_000)));
        assert!(!cache.contains_key(&(200, 2_000)));
    }

    #[test]
    fn sample_now_does_not_postpone_an_existing_periodic_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(
            sample_now_deadline(
                Some(deadline),
                Some(Duration::from_secs(5)),
                now + Duration::from_millis(100)
            ),
            Some(deadline)
        );
    }
}
