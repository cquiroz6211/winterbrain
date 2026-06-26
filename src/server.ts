import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureBrainFolders } from './paths.js';
import { buildGatewayServer } from './gateway.js';
import { startHttpGateway } from './http.js';

async function main(): Promise<void> {
  await ensureBrainFolders();
  const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

  if (transport === 'http') {
    const port = Number.parseInt(process.env.PORT || '3131', 10);
    const publicUrl = process.env.WINTERBRAIN_PUBLIC_URL || `http://localhost:${port}`;
    const allowAnonymous = process.env.WINTERBRAIN_ALLOW_ANONYMOUS === 'true';
    await startHttpGateway(() => buildGatewayServer(), {
      port,
      publicUrl,
      tokensRaw: process.env.WINTERBRAIN_TOKENS,
      allowAnonymous,
    });
    return;
  }

  const server = buildGatewayServer();
  await server.connect(new StdioServerTransport());
  console.error('Company Brain MCP server running on stdio');
}

main().catch((error: unknown) => {
  console.error('Fatal error in Company Brain MCP server:', error);
  process.exit(1);
});