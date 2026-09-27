import { connectCompanyClient } from './client';
import { readPrivateCredential } from './credential-file';

const [command, name, json] = Bun.argv.slice(2);
const url = process.env.SCK_MCP_URL;
const credential = process.env.SCK_EMPLOYEE_CREDENTIAL_FILE
  ? await readPrivateCredential(process.env.SCK_EMPLOYEE_CREDENTIAL_FILE)
  : process.env.SCK_EMPLOYEE_CREDENTIAL ?? '';

if (!url) throw new Error('SCK_MCP_URL is required');
if (!credential) throw new Error('SCK_EMPLOYEE_CREDENTIAL_FILE or SCK_EMPLOYEE_CREDENTIAL is required');
if (!['list', 'call'].includes(command ?? '')) throw new Error('usage: bun src/mcp/client-cli.ts list | call <tool> [json-arguments]');
if (command === 'call' && !name) throw new Error('tool name is required');

const connection = await connectCompanyClient({ url: new URL(url), credential, clientName: 'sck-employee-cli' });
try {
  const result = command === 'list'
    ? await connection.client.listTools()
    : await connection.client.callTool({ name: name!, arguments: json ? JSON.parse(json) : {} });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await connection.close();
}
