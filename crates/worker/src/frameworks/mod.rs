//! Framework metadata extraction plugins.
//!
//! Each plugin observes a parsed `RawFile` and returns framework-specific metadata.
//! The AST walkers stay framework-agnostic; plugins interpret syntax they understand
//! and the indexer (`index.rs`) turns their output into typed `Entity`/`Fact`/`Relationship`
//! rows with proper evidence and resolution labels.

use crate::language::RawFile;
use serde_json::Value;

pub mod config;
pub mod express;
pub mod nextjs;
pub mod nestjs;
pub mod java_gateway;
pub mod spring;

/// Framework-specific metadata emitted per source file.
#[derive(Debug, Clone)]
pub struct RawFrameworkMetadata {
    /// Which framework produced this row, e.g. "spring", "nestjs", "express".
    pub framework: &'static str,
    /// What kind of framework concept this row describes.
    pub kind: FrameworkEntityKind,
    /// Stable name within the file (class short name, route path, token, ...).
    pub name: String,
    /// Index into `RawFile.symbols` when the metadata is attached to a known symbol.
    pub subject_symbol: Option<usize>,
    /// Byte span in the source file for evidence.
    pub start: usize,
    pub end: usize,
    /// Framework-specific payload. The indexer only reads fields it understands.
    pub properties: Value,
    /// Logical parent id (module, controller, route group) when the plugin can name it.
    pub parent: Option<String>,
}

/// Kinds of framework concepts. Extend this as new plugins are added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameworkEntityKind {
    Controller,
    Route,
    Provider,
    Guard,
    Interceptor,
    Middleware,
    Module,
    Inject,
    Transaction,
    MessageListener,
    GatewayRoute,
    GatewayFilter,
    GatewayPredicate,
    ConfigValue,
    PersistenceEntity,
    PersistenceColumn,
}

impl FrameworkEntityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FrameworkEntityKind::Controller => "controller",
            FrameworkEntityKind::Route => "route",
            FrameworkEntityKind::Provider => "provider",
            FrameworkEntityKind::Guard => "guard",
            FrameworkEntityKind::Interceptor => "interceptor",
            FrameworkEntityKind::Middleware => "middleware",
            FrameworkEntityKind::Module => "module",
            FrameworkEntityKind::Inject => "inject",
            FrameworkEntityKind::Transaction => "transaction",
            FrameworkEntityKind::MessageListener => "message_listener",
            FrameworkEntityKind::GatewayRoute => "gateway_route",
            FrameworkEntityKind::GatewayFilter => "gateway_filter",
            FrameworkEntityKind::GatewayPredicate => "gateway_predicate",
            FrameworkEntityKind::ConfigValue => "config_value",
            FrameworkEntityKind::PersistenceEntity => "table",
            FrameworkEntityKind::PersistenceColumn => "column",
        }
    }
}

/// Per-file context passed to every plugin.
#[derive(Debug, Clone)]
pub struct FrameworkContext<'a> {
    pub rel: &'a str,
    pub src: &'a str,
    pub project_root: &'a std::path::Path,
}

/// A framework extension plugin.
pub trait FrameworkExtension: Send + Sync {
    /// Which framework this plugin handles.
    fn framework(&self) -> &'static str;

    /// Whether this plugin wants to process the given file.
    fn matches(&self, rel: &str) -> bool;

    /// Extract framework metadata from a parsed file.
    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile);
}

/// Default registry of built-in framework plugins.
pub fn default_registry() -> Vec<Box<dyn FrameworkExtension>> {
    vec![
        Box::new(crate::frameworks::spring::SpringExtension),
        Box::new(crate::frameworks::java_gateway::SpringCloudGatewayExtension),
        Box::new(crate::frameworks::nestjs::NestJsExtension),
        Box::new(crate::frameworks::express::ExpressExtension),
        Box::new(crate::frameworks::nextjs::NextJsExtension),
        Box::new(crate::frameworks::config::ConfigExtension),
    ]
}

/// Run all matching plugins against a parsed file.
pub fn apply(raw: &mut RawFile, ctx: FrameworkContext<'_>) {
    let registry = default_registry();
    for plugin in registry {
        if plugin.matches(ctx.rel) {
            plugin.extract(ctx.clone(), raw);
        }
    }
}
