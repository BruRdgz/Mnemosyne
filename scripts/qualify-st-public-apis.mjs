function parseOptions(argv) {
  const options = { baseUrl: 'http://127.0.0.1:8000' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base-url') options.baseUrl = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  options.baseUrl = String(options.baseUrl).replace(/\/$/, '');
  return options;
}

async function inspectEndpoint(baseUrl, path, checks) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, { redirect: 'error' });
  const source = await response.text();
  const result = {
    path,
    status: response.status,
    contentType: response.headers.get('content-type'),
    characters: source.length,
    checks: Object.fromEntries(checks.map(([name, pattern]) => [name, pattern.test(source)])),
  };
  result.ok = response.ok && Object.values(result.checks).every(Boolean);
  return result;
}

const options = parseOptions(process.argv.slice(2));
const endpoints = [
  inspectEndpoint(options.baseUrl, '/scripts/slash-commands/SlashCommandParser.js', [
    ['namedParserExport', /export\s+class\s+SlashCommandParser/],
    ['legacyAddCommand', /static\s+addCommand\s*\(/],
    ['objectAddCommand', /static\s+addCommandObject\s*\(/],
  ]),
  inspectEndpoint(options.baseUrl, '/scripts/extensions.js', [
    ['extensionSettingsExport', /export\s+(?:const|let|var)\s+extension_settings/],
    ['generationInterceptorExport', /export\s+async\s+function\s+runGenerationInterceptors/],
    ['metadataSaveExport', /export\s+(?:const|function|async\s+function)\s+saveMetadataDebounced/],
  ]),
];

const result = {
  mode: 'read-only-public-api-qualification',
  baseUrl: options.baseUrl,
  providerRequestsMade: 0,
  filesWritten: 0,
  endpoints: await Promise.all(endpoints),
};
result.qualified = result.endpoints.every(endpoint => endpoint.ok);
console.log(JSON.stringify(result, null, 2));
if (!result.qualified) process.exitCode = 1;
