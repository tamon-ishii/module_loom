# module-analysis Specification

## Purpose
Provides high-speed static analysis of Python source trees to extract module dependencies, detect circular imports, monitor module bloat metrics, and inspect type annotation and checking diagnostics.

## Requirements

### Requirement: Module Dependency Extraction
The system SHALL parse Python source files in a target directory and extract inter-module dependency relationships (both absolute and relative imports).

#### Scenario: Parse valid Python package
- **WHEN** the analyzer is executed on a Python package directory
- **THEN** it produces a directed dependency graph representing modules as nodes and import statements as directed edges with exact source/target module paths.

#### Scenario: Ignore standard library and external packages optionally
- **WHEN** the user configures the analyzer to filter internal project modules only
- **THEN** external packages (e.g., third-party or Python standard library) are grouped or excluded from the main internal dependency graph.

### Requirement: Circular Import Detection
The system SHALL identify all strongly connected components or cycles within the dependency graph that constitute circular imports.

#### Scenario: Detect direct circular import
- **WHEN** module `A` imports module `B` and module `B` imports module `A`
- **THEN** the analyzer flags this pair as a circular import cycle (`A -> B -> A`) and returns the exact import lines involved.

#### Scenario: Detect indirect circular import
- **WHEN** module `A` imports `B`, `B` imports `C`, and `C` imports `A`
- **THEN** the analyzer flags the cycle (`A -> B -> C -> A`) with diagnostic severity and step trace.

### Requirement: Module Bloat Monitoring
The system SHALL compute code size and complexity metrics for each module and flag modules that exceed configurable thresholds.

#### Scenario: Calculate module metrics
- **WHEN** a module is analyzed
- **THEN** the analyzer computes lines of code (LOC), number of classes, number of functions, and afferent/efferent coupling counts.

#### Scenario: Flag oversized module
- **WHEN** a module's LOC or dependency count exceeds the configured warning threshold
- **THEN** the analyzer marks the module with a bloat warning and reports the exceeding metric values.

### Requirement: Type Check Diagnostics Inspection
The system SHALL inspect Python type annotations and integrate type check diagnostics (such as `ty` or standard type checkers) into module health reports.

#### Scenario: Report type error diagnostics on module
- **WHEN** type checking diagnostics are generated for a module
- **THEN** the analyzer associates the errors/warnings with the corresponding module node and line numbers in the graph dataset.
