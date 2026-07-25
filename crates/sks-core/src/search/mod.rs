mod files;
mod text;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read};
use std::time::Instant;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    #[allow(dead_code)]
    pub schema_version: u32,
    pub mode: String,
    pub root: String,
    pub query: Option<String>,
    pub pattern: Option<String>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
    pub case_sensitive: Option<bool>,
    pub limits: Option<SearchLimits>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchLimits {
    pub max_matches: Option<usize>,
    pub max_files: Option<usize>,
    pub max_bytes: Option<u64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub confidence: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub schema_version: u32,
    pub schema: String,
    pub ok: bool,
    pub mode: String,
    pub provider: String,
    pub engine: String,
    pub matches: Vec<SearchMatch>,
    pub confidence: String,
    pub truncated: bool,
    pub timeout: bool,
    pub limits: LimitsOut,
    pub scanned: ScannedOut,
    pub skipped: SkippedOut,
    pub cache_hit: bool,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub duration_ms: u64,
    pub process_spawns: u32,
    pub deterministic_order: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsOut {
    pub max_matches: usize,
    pub max_files: usize,
    pub max_bytes: u64,
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedOut {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedOut {
    pub files: usize,
    pub reasons: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchRequest {
    #[allow(dead_code)]
    pub schema_version: u32,
    pub root: String,
    pub requests: Vec<SearchRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchResponse {
    pub schema_version: u32,
    pub schema: String,
    pub ok: bool,
    pub provider: String,
    pub responses: Vec<SearchResponse>,
    pub process_spawns: u32,
    pub duration_ms: u64,
}

pub fn run(args: &[String]) -> i32 {
    let mut rest = args.to_vec();
    let mut json_mode = false;
    rest.retain(|a| {
        if a == "--json" {
            json_mode = true;
            false
        } else {
            true
        }
    });
    if rest.is_empty() || rest[0] == "--help" || rest[0] == "help" {
        eprintln!("sks-rs search files|text|batch --json  (JSON request on stdin)");
        return if rest.is_empty() { 2 } else { 0 };
    }
    let mode = rest[0].as_str();
    let started = Instant::now();
    match mode {
        "files" | "text" => {
            let req = read_request();
            let mut req = match req {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("{}", e);
                    return 1;
                }
            };
            req.mode = mode.to_string();
            let resp = dispatch(req);
            print_json(&resp);
            if !json_mode {
                // still JSON for machine responses only
            }
            if resp.ok {
                0
            } else if resp.errors.iter().any(|e| e.starts_with("invalid_")) {
                2
            } else {
                1
            }
        }
        "batch" => {
            let batch: BatchRequest = match read_stdin_json() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{}", e);
                    return 1;
                }
            };
            let mut responses = Vec::new();
            for mut req in batch.requests {
                if req.root.is_empty() {
                    req.root = batch.root.clone();
                }
                responses.push(dispatch(req));
            }
            let out = BatchResponse {
                schema_version: 1,
                schema: "sks.search-batch.v1".to_string(),
                ok: responses.iter().all(|r| r.ok),
                provider: "sks-rs".to_string(),
                process_spawns: 1,
                duration_ms: started.elapsed().as_millis() as u64,
                responses,
            };
            print_json(&out);
            if out.ok { 0 } else { 1 }
        }
        _ => {
            eprintln!("unknown search mode: {} (files|text|batch)", mode);
            2
        }
    }
}

fn dispatch(req: SearchRequest) -> SearchResponse {
    let started = Instant::now();
    let limits = normalize_limits(req.limits.as_ref());
    match req.mode.as_str() {
        "files" => files::search_files(req, limits, started),
        "text" => text::search_text(req, limits, started),
        other => error_response(other, limits, started, vec![format!("unsupported_mode:{}", other)]),
    }
}

pub(crate) fn normalize_limits(limits: Option<&SearchLimits>) -> LimitsOut {
    LimitsOut {
        max_matches: limits.and_then(|l| l.max_matches).unwrap_or(500),
        max_files: limits.and_then(|l| l.max_files).unwrap_or(50_000),
        max_bytes: limits.and_then(|l| l.max_bytes).unwrap_or(32 * 1024 * 1024),
        timeout_ms: limits.and_then(|l| l.timeout_ms).unwrap_or(30_000),
    }
}

pub(crate) fn empty_skipped() -> SkippedOut {
    SkippedOut {
        files: 0,
        reasons: serde_json::Map::new(),
    }
}

pub(crate) fn bump_skip(skipped: &mut SkippedOut, reason: &str) {
    skipped.files += 1;
    let entry = skipped.reasons.entry(reason.to_string()).or_insert(Value::from(0));
    if let Some(n) = entry.as_u64() {
        *entry = Value::from(n + 1);
    }
}

pub(crate) fn base_ok(mode: &str, engine: &str, limits: LimitsOut, started: Instant) -> SearchResponse {
    SearchResponse {
        schema_version: 1,
        schema: "sks.search-provider.v1".to_string(),
        ok: true,
        mode: mode.to_string(),
        provider: "sks-rs".to_string(),
        engine: engine.to_string(),
        matches: vec![],
        confidence: if mode == "files" { "file_path".into() } else { "text_candidate".into() },
        truncated: false,
        timeout: false,
        limits,
        scanned: ScannedOut { files: 0, bytes: 0 },
        skipped: empty_skipped(),
        cache_hit: false,
        warnings: vec![],
        errors: vec![],
        duration_ms: started.elapsed().as_millis() as u64,
        process_spawns: 0,
        deterministic_order: "path_line_column".to_string(),
    }
}

fn error_response(mode: &str, limits: LimitsOut, started: Instant, errors: Vec<String>) -> SearchResponse {
    let mut resp = base_ok(mode, "sks-rs", limits, started);
    resp.ok = false;
    resp.errors = errors;
    resp
}

fn read_request() -> Result<SearchRequest, String> {
    read_stdin_json()
}

fn read_stdin_json<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())?;
    if input.trim().is_empty() {
        return Err("empty_stdin_json".to_string());
    }
    serde_json::from_str(&input).map_err(|e| format!("invalid_json:{}", e))
}

fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string(value) {
        Ok(s) => println!("{}", s),
        Err(e) => {
            eprintln!("{}", e);
        }
    }
}
