import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { makeSandbox, runScript } from './script-harness';

jest.setTimeout(60_000);

interface StubOllama {
  url: string;
  pulled: string[];
  close: () => Promise<void>;
}

/** Minimal Ollama API: GET /api/tags lists models, POST /api/pull "installs" one. */
function startStubOllama(initial: string[], failPull: string[] = []): Promise<StubOllama> {
  const models = new Set(initial);
  const pulled: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/tags') {
        // Pretty-printed on purpose: the script must not depend on compact JSON.
        res.end(JSON.stringify({ models: [...models].map((name) => ({ name })) }, null, 2));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/pull') {
        const { model } = JSON.parse(body) as { model: string };
        if (failPull.includes(model)) {
          res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }));
          return;
        }
        pulled.push(model);
        models.add(model.includes(':') ? model : `${model}:latest`);
        res.end(JSON.stringify({ status: 'success' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        pulled,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const modelsEnv = (url: string): Record<string, string> => ({
  AI_PROVIDER: 'ollama',
  AI_BASE_URL: url,
  AI_GENERATION_MODEL: 'qwen2.5:7b-instruct',
  AI_EMBEDDING_MODEL: 'bge-m3',
});

describe('scripts/pull-models.sh (local models)', () => {
  it('pulls the missing local models and exits 0 once both are listed', async () => {
    const ollama = await startStubOllama([]);
    try {
      const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', [], modelsEnv(ollama.url));
      expect(result.code).toBe(0);
      expect(ollama.pulled.sort()).toEqual(['bge-m3', 'qwen2.5:7b-instruct']);
      expect(result.stdout).toMatch(/All 2 model\(s\) present/);
    } finally {
      await ollama.close();
    }
  });

  it('does not pull models that are already present', async () => {
    const ollama = await startStubOllama(['qwen2.5:7b-instruct', 'bge-m3:latest']);
    try {
      const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', [], modelsEnv(ollama.url));
      expect(result.code).toBe(0);
      expect(ollama.pulled).toEqual([]);
    } finally {
      await ollama.close();
    }
  });

  it('exits 1 when a pull fails', async () => {
    const ollama = await startStubOllama([], ['bge-m3']);
    try {
      const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', [], modelsEnv(ollama.url));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/bge-m3 failed/);
    } finally {
      await ollama.close();
    }
  });

  it('exits 1 with guidance when Ollama is unreachable', async () => {
    const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', [], modelsEnv('http://127.0.0.1:9'));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Ollama is not reachable/);
  });

  it('refuses a model name that could inject JSON', async () => {
    const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', ['--extra', 'x", "stream": true, "y'], {
      ...modelsEnv('http://127.0.0.1:9'),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Invalid model name/);
  });

  it('skips pulling when the provider is not Ollama', async () => {
    const result = await runScript(makeSandbox(), 'scripts/pull-models.sh', [], {
      ...modelsEnv('http://127.0.0.1:9'),
      AI_PROVIDER: 'openai_compatible',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing to pull/);
  });
});
