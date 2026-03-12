import { parseWebBinaryServeOptions } from "./binary_entry.ts";

interface CompiledFreshServerModule {
  default: {
    fetch: unknown;
  };
}

async function importCompiledFreshServer(): Promise<CompiledFreshServerModule> {
  return await import("../_fresh/server.js") as CompiledFreshServerModule;
}

if (import.meta.main) {
  try {
    const options = parseWebBinaryServeOptions(Deno.args, Deno.env.toObject());
    const serverModule = await importCompiledFreshServer();
    Deno.serve(
      options,
      serverModule.default.fetch as unknown as Deno.ServeHandler<Deno.NetAddr>,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kato-web startup failed: ${message}`);
    Deno.exit(2);
  }
}
