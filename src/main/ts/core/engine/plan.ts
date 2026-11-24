import { Ajv2020 } from 'ajv/dist/2020.js';
import { isJsonValue } from '../model/plugin-data.js';
import { pluginApi } from './plugin.js';
import type { LegacyPlugin, Operation, Plugin, ProductDeclaration } from './plugin.js';
import { manifestProducts } from './manifest.js';

export type InputBinding = { readonly external: string } | { readonly operation: string };

export interface PlanRequest {
  readonly plugins: readonly (Plugin | LegacyPlugin)[];
  readonly select: readonly string[];
  readonly inputs: ReadonlyMap<string, string>;
  readonly bindings?: ReadonlyMap<string, Readonly<Record<string, InputBinding>>>;
  /** Explicit migration exception for named v1 plugins that predate the manifest. */
  readonly legacyPluginIds?: readonly string[];
}

export interface PlannedOperation {
  readonly key: string;
  readonly operation: Operation;
  readonly inputs: ReadonlyMap<string, InputBinding>;
  readonly declaration?: ProductDeclaration;
  readonly validateOutput?: (value: unknown) => boolean;
  readonly cacheIdentity?: string;
}

export function plan(request: PlanRequest): readonly PlannedOperation[] {
  const { operations, declarations, cacheIdentities } = indexOperations(request.plugins, new Set(request.legacyPluginIds));
  const resolved = new Map<string, PlannedOperation>();
  const path: string[] = [];

  function visit(key: string): void {
    const cycle = path.indexOf(key);
    if (cycle >= 0) throw new Error(`Plugin dependency cycle: ${[...path.slice(cycle), key].join(' -> ')}`);
    if (resolved.has(key)) return;
    const operation = operations.get(key);
    if (!operation) throw new Error(`Unknown operation: ${key}`);

    path.push(key);
    const inputs = new Map<string, InputBinding>();
    const declared = request.bindings?.get(key);
    for (const name of Object.keys(declared ?? {})) {
      if (!Object.hasOwn(operation.inputs, name)) throw new Error(`Unknown input port: ${key}.${name}`);
    }
    for (const [name, contract] of Object.entries(operation.inputs)) {
      const explicit = declared && Object.hasOwn(declared, name) ? declared[name] : undefined;
      const candidates = explicit ? [explicit] : candidatesFor(contract.id, request.inputs, operations);
      const binding = candidates[0];
      if (!binding) throw new Error(`Missing input ${key}.${name} (${contract.id})`);
      if (candidates.length > 1) throw new Error(`Ambiguous input ${key}.${name} (${contract.id})`);
      if (('external' in binding) === ('operation' in binding)) {
        throw new Error(`Expected one binding for ${key}.${name}`);
      }
      const actual = 'external' in binding
        ? request.inputs.get(binding.external)
        : operations.get(binding.operation)?.output.id;
      if (actual !== contract.id) throw new Error(`Incompatible input ${key}.${name}: expected ${contract.id}, got ${actual ?? 'missing'}`);

      if ('operation' in binding) visit(binding.operation);
      inputs.set(name, binding);
    }
    path.pop();
    const declaration = declarations.get(key);
    const validateOutput = declaration?.schema === undefined ? undefined : validateSchema(declaration.schema, key);
    const cacheIdentity = cacheIdentities.get(key);
    resolved.set(key, { key, operation, inputs, ...(declaration === undefined ? {} : { declaration }),
      ...(validateOutput === undefined ? {} : { validateOutput }), ...(cacheIdentity === undefined ? {} : { cacheIdentity }) });
  }

  for (const key of request.select) visit(key);
  return [...resolved.values()];
}

function validateSchema(schema: NonNullable<ProductDeclaration['schema']>, key: string): (value: unknown) => boolean {
  try {
    return new Ajv2020().compile(schema);
  } catch (error) {
    throw new Error(`Invalid product schema for ${key}`, { cause: error });
  }
}

function indexOperations(plugins: PlanRequest['plugins'], legacyPlugins: ReadonlySet<string>) {
  const ids = new Set<string>();
  const operations = new Map<string, Operation>();
  const declarations = new Map<string, ProductDeclaration>();
  const cacheIdentities = new Map<string, string>();
  const metricOwners = new Map<string, string>();
  for (const plugin of plugins) {
    if (plugin.api !== pluginApi) throw new Error(`Unsupported plugin API for ${plugin.id}: ${plugin.api}`);
    if (ids.has(plugin.id) || !plugin.id || plugin.id.includes('/')) throw new Error(`Invalid or duplicate plugin ID: ${plugin.id}`);
    ids.add(plugin.id);
    const products = manifestProducts(plugin, legacyPlugins.has(plugin.id));
    if (plugin.settings !== undefined) {
      if (!isJsonValue(plugin.settings)) throw new Error(`Plugin settings must be JSON data: ${plugin.id}`);
      if (plugin.config !== undefined && !new Ajv2020().validate(plugin.config, plugin.settings)) {
        throw new Error(`Plugin settings violate the configuration schema: ${plugin.id}`);
      }
    }
    for (const declaration of products?.values() ?? []) {
      for (const metric of declaration.metrics ?? []) {
        const owner = metricOwners.get(metric.id);
        if (owner !== undefined) throw new Error(`Duplicate metric ${metric.id} in plugins ${owner} and ${plugin.id}`);
        metricOwners.set(metric.id, plugin.id);
      }
    }
    for (const operation of plugin.operations) {
      const key = `${plugin.id}/${operation.id}`;
      if (operations.has(key) || !operation.id || operation.id.includes('/')) throw new Error(`Invalid or duplicate operation: ${key}`);
      if (operation.scope !== undefined && operation.scope !== 'file' && operation.scope !== 'repository') {
        throw new Error(`Invalid operation scope: ${key}`);
      }
      if (products !== undefined) {
        const declaration = products.get(operation.output.id);
        if (!declaration) throw new Error(`Undeclared output for ${key}: ${operation.output.id}`);
        declarations.set(key, declaration);
        if (declaration.persistence === 'cache') {
          cacheIdentities.set(key, JSON.stringify([
            plugin.api, plugin.version, Object.entries(plugin.tools ?? {}).sort(), plugin.settings, operation.scope, operation.implementation,
            declaration.contract, declaration.schema,
          ]));
        }
      }
      operations.set(key, operation);
    }
  }
  return { operations, declarations, cacheIdentities };
}

function candidatesFor(contract: string, inputs: ReadonlyMap<string, string>, operations: ReadonlyMap<string, Operation>): InputBinding[] {
  const candidates: InputBinding[] = [];
  for (const [external, id] of inputs) if (id === contract) candidates.push({ external });
  for (const [operation, candidate] of operations) if (candidate.output.id === contract) candidates.push({ operation });
  return candidates;
}
