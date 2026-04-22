const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const GRAPH_PATH = path.join(ROOT, 'graphify-out', 'graph.json')
const MARKER = 'mapart-bot-graphify-augment'
const CONTEXT_SOURCE = 'docs/GRAPHIFY-CONTEXT.md'

function normalizeId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function fileId(relPath) {
  return normalizeId(relPath)
}

function loadGraph() {
  if (!fs.existsSync(GRAPH_PATH)) {
    throw new Error(`graph.json not found at ${GRAPH_PATH}. Run "graphify update ." first.`)
  }
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'))
}

function ensureArray(object, key, fallbackKey) {
  if (Array.isArray(object[key])) return object[key]
  if (fallbackKey && Array.isArray(object[fallbackKey])) {
    object[key] = object[fallbackKey]
    return object[key]
  }
  object[key] = []
  return object[key]
}

function uniqueBy(items, keyFn) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function addFileNode(nodes, relPath, extra = {}) {
  const id = fileId(relPath)
  nodes.push({
    id,
    label: relPath,
    norm_label: relPath.toLowerCase(),
    file_type: extra.file_type || 'document',
    source_file: relPath,
    source_location: null,
    generated_by: MARKER,
    ...extra
  })
  return id
}

function addConceptNode(nodes, id, label, extra = {}) {
  nodes.push({
    id,
    label,
    norm_label: label.toLowerCase(),
    file_type: 'document',
    source_file: CONTEXT_SOURCE,
    source_location: null,
    generated_by: MARKER,
    ...extra
  })
  return id
}

function addEdge(links, source, target, relation, sourceFile, extra = {}) {
  links.push({
    source,
    target,
    relation,
    confidence: 'EXTRACTED',
    confidence_score: 1.0,
    source_file: sourceFile,
    source_location: null,
    weight: 1.0,
    generated_by: MARKER,
    ...extra
  })
}

function main() {
  const graph = loadGraph()
  const nodes = ensureArray(graph, 'nodes')
  const links = ensureArray(graph, 'links', 'edges')

  const preservedNodes = nodes.filter(node => node.generated_by !== MARKER)
  const preservedLinks = links.filter(link => link.generated_by !== MARKER)

  const addedNodes = []
  const addedLinks = []

  const runtimeCode = {
    nervWrapper: 'nerv_printer_js',
    nervCli: 'src_nerv_printer_cli_js',
    workload: 'src_nerv_printer_placement_workload_js',
    diagMove: 'src_nerv_printer_diagnostics_move_test_js',
    diagRescan: 'src_nerv_printer_diagnostics_rescan_js',
    diagState: 'src_nerv_printer_diagnostics_state_manager_js',
    diagVerify: 'src_nerv_printer_diagnostics_verify_js',
    broadcastCli: 'src_broadcast_cli_js',
    broadcastTest: 'src_broadcast_test_cli_js',
    dashServer: 'dashboard_service_src_server_js',
    dashStore: 'dashboard_service_src_store_js',
    dashApp: 'dashboard_service_public_assets_app_js'
  }

  const fileNodes = {
    readme: addFileNode(addedNodes, 'README.md'),
    rootPackage: addFileNode(addedNodes, 'package.json'),
    configTest: addFileNode(addedNodes, 'config.test.json'),
    graphifySetup: addFileNode(addedNodes, 'docs/GRAPHIFY-SETUP.md'),
    graphifyContext: addFileNode(addedNodes, 'docs/GRAPHIFY-CONTEXT.md'),
    dashboardSetup: addFileNode(addedNodes, 'docs/DESKTOP-DASHBOARD-SETUP.md'),
    sixb6tDoc: addFileNode(addedNodes, 'docs/6b6t.txt'),
    anchorDoc: addFileNode(addedNodes, 'docs/anchorinformation.txt'),
    ec2Doc: addFileNode(addedNodes, 'docs/EC2-DEPLOY.md'),
    serviceExample: addFileNode(addedNodes, 'docs/nerv-printer.service.example'),
    dashPackage: addFileNode(addedNodes, 'dashboard-service/package.json'),
    dashIndex: addFileNode(addedNodes, 'dashboard-service/public/index.html'),
    dashStyles: addFileNode(addedNodes, 'dashboard-service/public/assets/styles.css'),
    operators: addFileNode(addedNodes, 'dashboard-service/data/operators.json'),
    printerConfig: addFileNode(addedNodes, 'nerv-printer-config/_configs/nerv-printer-config.json'),
    printerConfigPremium: addFileNode(addedNodes, 'nerv-printer-config/_configs/nerv-printer-config-premium-1.json'),
    carpetConfig: addFileNode(addedNodes, 'nerv-printer-config/_configs/carpet-printer-config.json'),
    legacyCarpetConfig: addFileNode(addedNodes, 'nerv-printer-config/_configs/legacy-nerv-carpet-printer-config.json'),
    marioNbt: addFileNode(addedNodes, 'nerv-printer-config/mario.nbt'),
    strawberryNbt: addFileNode(addedNodes, 'nerv-printer-config/strawberry.nbt'),
    spatialAwareness: addFileNode(addedNodes, 'spatial-awareness/6b6t-ComicSquid007.json'),
    meteorJar: addFileNode(addedNodes, 'assets/MeteorSpatialFileGenerator.jar'),
    legacySchematic: addFileNode(addedNodes, 'assets/schematics/legacy-nerv-printer-carpet-platform.litematic'),
    carpetSchematic: addFileNode(addedNodes, 'assets/schematics/carpetPrinterSchematicV2.litematic')
  }

  const concepts = {
    runtime: addConceptNode(addedNodes, 'ctx_nerv_printer_runtime', 'NERV printer runtime'),
    dashboard: addConceptNode(addedNodes, 'ctx_dashboard_service', 'Dashboard service'),
    printerConfig: addConceptNode(addedNodes, 'ctx_printer_configuration', 'Printer configuration'),
    docs: addConceptNode(addedNodes, 'ctx_operational_docs', 'Operational documentation'),
    artifacts: addConceptNode(addedNodes, 'ctx_spatial_and_layout_artifacts', 'Spatial and layout artifacts'),
    graphify: addConceptNode(addedNodes, 'ctx_graphify_workflow', 'Graphify repo workflow')
  }

  addEdge(addedLinks, concepts.runtime, runtimeCode.nervWrapper, 'entrypoint_for', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.nervCli, 'implements', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.workload, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.diagMove, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.diagRescan, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.diagState, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.diagVerify, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.broadcastCli, 'relates_to', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.runtime, runtimeCode.broadcastTest, 'relates_to', CONTEXT_SOURCE)

  addEdge(addedLinks, concepts.dashboard, runtimeCode.dashServer, 'implements', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.dashboard, runtimeCode.dashStore, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.dashboard, runtimeCode.dashApp, 'uses', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.dashboard, fileNodes.dashIndex, 'documents', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.dashboard, fileNodes.dashStyles, 'documents', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.dashboard, fileNodes.operators, 'uses', CONTEXT_SOURCE)

  addEdge(addedLinks, concepts.printerConfig, fileNodes.printerConfig, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.printerConfig, fileNodes.printerConfigPremium, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.printerConfig, fileNodes.carpetConfig, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.printerConfig, fileNodes.legacyCarpetConfig, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.printerConfig, runtimeCode.nervCli, 'configures', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.printerConfig, runtimeCode.nervWrapper, 'configures', CONTEXT_SOURCE)

  addEdge(addedLinks, concepts.docs, fileNodes.readme, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.docs, fileNodes.dashboardSetup, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.docs, fileNodes.sixb6tDoc, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.docs, fileNodes.anchorDoc, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.docs, fileNodes.ec2Doc, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.docs, fileNodes.serviceExample, 'contains', CONTEXT_SOURCE)

  addEdge(addedLinks, concepts.artifacts, fileNodes.marioNbt, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, fileNodes.strawberryNbt, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, fileNodes.spatialAwareness, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, fileNodes.meteorJar, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, fileNodes.legacySchematic, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, fileNodes.carpetSchematic, 'contains', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.artifacts, runtimeCode.nervCli, 'supports', CONTEXT_SOURCE)

  addEdge(addedLinks, concepts.graphify, fileNodes.graphifySetup, 'documents', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.graphify, fileNodes.graphifyContext, 'documents', CONTEXT_SOURCE)
  addEdge(addedLinks, concepts.graphify, fileNodes.rootPackage, 'uses', CONTEXT_SOURCE)

  addEdge(addedLinks, fileNodes.readme, runtimeCode.nervWrapper, 'documents', 'README.md')
  addEdge(addedLinks, fileNodes.readme, runtimeCode.nervCli, 'documents', 'README.md')
  addEdge(addedLinks, fileNodes.readme, fileNodes.printerConfig, 'documents', 'README.md')
  addEdge(addedLinks, fileNodes.readme, fileNodes.dashboardSetup, 'references', 'README.md')

  addEdge(addedLinks, fileNodes.rootPackage, runtimeCode.nervWrapper, 'starts', 'package.json')
  addEdge(addedLinks, fileNodes.rootPackage, runtimeCode.diagMove, 'runs_test_for', 'package.json')
  addEdge(addedLinks, fileNodes.rootPackage, concepts.graphify, 'documents', 'package.json')

  addEdge(addedLinks, fileNodes.dashPackage, runtimeCode.dashServer, 'starts', 'dashboard-service/package.json')
  addEdge(addedLinks, fileNodes.dashboardSetup, concepts.dashboard, 'documents', 'docs/DESKTOP-DASHBOARD-SETUP.md')
  addEdge(addedLinks, fileNodes.dashboardSetup, runtimeCode.dashServer, 'documents', 'docs/DESKTOP-DASHBOARD-SETUP.md')
  addEdge(addedLinks, fileNodes.dashboardSetup, runtimeCode.dashApp, 'documents', 'docs/DESKTOP-DASHBOARD-SETUP.md')

  addEdge(addedLinks, fileNodes.printerConfig, runtimeCode.nervCli, 'configures', 'nerv-printer-config/_configs/nerv-printer-config.json')
  addEdge(addedLinks, fileNodes.printerConfigPremium, runtimeCode.nervCli, 'configures', 'nerv-printer-config/_configs/nerv-printer-config-premium-1.json')
  addEdge(addedLinks, fileNodes.carpetConfig, runtimeCode.nervCli, 'configures', 'nerv-printer-config/_configs/carpet-printer-config.json')
  addEdge(addedLinks, fileNodes.legacyCarpetConfig, runtimeCode.nervCli, 'configures', 'nerv-printer-config/_configs/legacy-nerv-carpet-printer-config.json')
  addEdge(addedLinks, fileNodes.configTest, runtimeCode.nervCli, 'configures', 'config.test.json')

  addEdge(addedLinks, fileNodes.marioNbt, runtimeCode.nervCli, 'feeds', 'nerv-printer-config/mario.nbt')
  addEdge(addedLinks, fileNodes.strawberryNbt, runtimeCode.nervCli, 'feeds', 'nerv-printer-config/strawberry.nbt')
  addEdge(addedLinks, fileNodes.spatialAwareness, runtimeCode.nervCli, 'supports', 'spatial-awareness/6b6t-ComicSquid007.json')
  addEdge(addedLinks, fileNodes.legacySchematic, runtimeCode.nervCli, 'supports', 'assets/schematics/legacy-nerv-printer-carpet-platform.litematic')
  addEdge(addedLinks, fileNodes.carpetSchematic, runtimeCode.nervCli, 'supports', 'assets/schematics/carpetPrinterSchematicV2.litematic')
  addEdge(addedLinks, fileNodes.meteorJar, fileNodes.spatialAwareness, 'supports', 'assets/MeteorSpatialFileGenerator.jar')

  addEdge(addedLinks, fileNodes.dashIndex, runtimeCode.dashApp, 'supports_ui', 'dashboard-service/public/index.html')
  addEdge(addedLinks, fileNodes.dashStyles, runtimeCode.dashApp, 'styles', 'dashboard-service/public/assets/styles.css')
  addEdge(addedLinks, fileNodes.operators, runtimeCode.dashServer, 'authorizes', 'dashboard-service/data/operators.json')
  addEdge(addedLinks, fileNodes.operators, runtimeCode.dashApp, 'authorizes', 'dashboard-service/data/operators.json')

  addEdge(addedLinks, fileNodes.sixb6tDoc, runtimeCode.nervCli, 'documents', 'docs/6b6t.txt')
  addEdge(addedLinks, fileNodes.anchorDoc, runtimeCode.nervCli, 'documents', 'docs/anchorinformation.txt')
  addEdge(addedLinks, fileNodes.ec2Doc, runtimeCode.dashServer, 'documents', 'docs/EC2-DEPLOY.md')
  addEdge(addedLinks, fileNodes.serviceExample, runtimeCode.nervCli, 'deploys', 'docs/nerv-printer.service.example')
  addEdge(addedLinks, fileNodes.graphifySetup, concepts.graphify, 'documents', 'docs/GRAPHIFY-SETUP.md')
  addEdge(addedLinks, fileNodes.graphifyContext, concepts.runtime, 'documents', 'docs/GRAPHIFY-CONTEXT.md')
  addEdge(addedLinks, fileNodes.graphifyContext, concepts.dashboard, 'documents', 'docs/GRAPHIFY-CONTEXT.md')
  addEdge(addedLinks, fileNodes.graphifyContext, concepts.printerConfig, 'documents', 'docs/GRAPHIFY-CONTEXT.md')
  addEdge(addedLinks, fileNodes.graphifyContext, concepts.docs, 'documents', 'docs/GRAPHIFY-CONTEXT.md')
  addEdge(addedLinks, fileNodes.graphifyContext, concepts.artifacts, 'documents', 'docs/GRAPHIFY-CONTEXT.md')

  graph.nodes = uniqueBy([...preservedNodes, ...addedNodes], node => node.id)
  graph.links = uniqueBy([...preservedLinks, ...addedLinks], link => {
    return [
      link.source,
      link.target,
      link.relation,
      link.source_file,
      link.generated_by || ''
    ].join('::')
  })
  delete graph.edges

  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2))
  console.log(`Augmented ${path.relative(ROOT, GRAPH_PATH)} with ${addedNodes.length} context nodes and ${addedLinks.length} context edges.`)
}

main()
