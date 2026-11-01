/**
 * The vitest-based adapter contract harness, isolated behind its own export
 * subpath (`@fleetos/adapters-sdk/contract`) so the package root stays
 * importable outside vitest — the scheduler bench CLI and future apps import
 * simulators and registries without dragging a test runner into the graph.
 */

export * from "./define-adapter-contract-tests.js";
