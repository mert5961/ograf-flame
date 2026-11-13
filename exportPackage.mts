/**
 * Exports one template of an OGraf Studio `.ogs` template set as an extracted
 * non-realtime OGraf package folder, using the code of a local OGraf Studio checkout.
 *
 * Usage (run with the checkout's tsx):
 *   node <studio>/node_modules/tsx/dist/cli.mjs exportPackage.mts <studioDir> <input.ogs> <outDir> [templateName]
 *
 * The package is not run through the editor's browser-based certification gate;
 * export from Studio (Non-real-time or Dual profile) when you need a certified package.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [studioArg, input, outDir, templateName] = process.argv.slice(2);
if (!studioArg || !input || !outDir)
  throw new Error('Usage: exportPackage.mts <studioDir> <input.ogs> <outDir> [templateName]');

const studio = resolve(studioArg);
const load = (path: string) => import(pathToFileURL(join(studio, path)).href);
const { BUILT_IN_EXPORT_PROFILES, buildExportArtifactsWithRuntime } = await load(
  'packages/codegen/src/index.ts',
);
const { openProjectSetArchive } = await load('apps/editor/src/state/projectSet.ts');

const runtimePath = join(studio, 'packages/ograf-runtime/dist/graphic-runtime.js');
let runtimeSource: string;
try {
  runtimeSource = await readFile(runtimePath, 'utf8');
} catch {
  throw new Error(
    `OGraf runtime not built. Run "npm ci && npm run build --workspace @ograf-editor/ograf-runtime" in ${studio}.`,
  );
}

type Template = { id: string; name: string; project: any };
const bytes = new Uint8Array(await readFile(resolve(input)));
// A .ogs is normally a zip template set; Studio's MCP tools can also save one project as plain JSON.
const isJson = String.fromCharCode(...bytes.slice(0, 64)).trimStart().startsWith('{');
let set: { templates: Template[]; activeTemplateId?: string };
if (isJson) {
  const project = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(project.compositions))
    throw new Error('This JSON file is not an OGraf Studio project.');
  set = { templates: [{ id: project.id, name: project.name || 'Untitled', project }] };
} else {
  set = await openProjectSetArchive(bytes);
}
const templates: Template[] = set.templates;
const template = templateName
  ? templates.find((t) => t.name === templateName)
  : (templates.find((t) => t.id === set.activeTemplateId) ?? templates[0]);
if (!template) {
  const names = templates.map((t) => `  - ${t.name}`).join('\n');
  throw new Error(`Template "${templateName}" not found. Templates in this set:\n${names}`);
}

const project = template.project;
const composition =
  project.compositions.find((c: { id: string }) => c.id === project.mainCompositionId) ??
  project.compositions[0];
if (!composition) throw new Error(`Template "${template.name}" has no composition.`);

const profile = BUILT_IN_EXPORT_PROFILES.find((p: { mode: string }) => p.mode === 'non-realtime');
const artifacts = buildExportArtifactsWithRuntime(project, composition, runtimeSource, profile);
if (!artifacts.valid) throw new Error(`Export failed:\n${artifacts.errors.join('\n')}`);

const out = resolve(outDir);
await mkdir(out, { recursive: true });
await writeFile(join(out, artifacts.manifestFileName), JSON.stringify(artifacts.manifest, null, 2));
await writeFile(join(out, 'main.js'), artifacts.mainJs);
for (const resource of artifacts.resources as Array<{
  path: string;
  data: string;
  base64: boolean;
}>) {
  const target = join(out, resource.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(resource.data, resource.base64 ? 'base64' : 'utf8'));
}
console.log(
  JSON.stringify({
    template: template.name,
    templates: templates.map((t) => t.name),
    manifest: join(out, artifacts.manifestFileName),
  }),
);
