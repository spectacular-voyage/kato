import server from "../_fresh/server.js";
import { parseWebBinaryServeOptions } from "./binary_entry.ts";

if (import.meta.main) {
  try {
    const options = parseWebBinaryServeOptions(Deno.args, Deno.env.toObject());
    Deno.serve(
      options,
      server.fetch as unknown as Deno.ServeHandler<Deno.NetAddr>,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kato-web startup failed: ${message}`);
    Deno.exit(2);
  }
}
