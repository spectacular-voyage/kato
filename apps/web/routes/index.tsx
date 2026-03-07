import { Head } from "fresh/runtime";
import SummaryLive from "../islands/SummaryLive.tsx";
import { loadSummaryPageData } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

export default define.page(async function Home() {
  const summary = await loadSummaryPageData();

  return (
    <>
      <Head>
        <title>Kato Web · Summary</title>
      </Head>
      <SummaryLive initialData={summary} />
    </>
  );
});
