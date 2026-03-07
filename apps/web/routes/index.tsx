import { Head } from "fresh/runtime";
import SummaryLive from "../islands/SummaryLive.tsx";
import { loadSummaryPageData } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

export default define.page(async function Home(ctx) {
  const summary = await loadSummaryPageData();

  return (
    <>
      <Head>
        <title>Kato Web</title>
      </Head>
      <SummaryLive
        initialData={summary}
        csrfToken={ctx.state.csrfToken}
      />
    </>
  );
});
