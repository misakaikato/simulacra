#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };

console.log(`simulacra ${pkg.version}`);
