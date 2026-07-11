import type { ComponentChildren } from "preact";
import type {
  OutputWriterPolicyProjection,
  WriterPolicyFlagProjection,
} from "./output_writer_policy.ts";
import { writerPolicyTriState } from "./output_writer_policy.ts";

export function writerPolicyFlagSummary(
  label: string,
  flag: WriterPolicyFlagProjection,
): string | undefined {
  if (flag.override === undefined) {
    return undefined;
  }
  const verb = flag.override ? "included" : "excluded";
  return flag.override === flag.defaultValue
    ? `${label} ${verb} (matches workspace default)`
    : `${label} ${verb}, overriding workspace default`;
}

function defaultChoiceLabel(flag: WriterPolicyFlagProjection): string {
  return `default (${flag.defaultValue ? "include" : "exclude"})`;
}

function WriterPolicySelect(props: {
  label: string;
  name: "commentary" | "thinking";
  flag: WriterPolicyFlagProjection;
}) {
  const summary = writerPolicyFlagSummary(props.label, props.flag);
  return (
    <label class="writer-policy-control" title={summary}>
      <span class="writer-policy-label muted">{props.label}</span>
      <select
        class="form-input writer-policy-select mono"
        name={props.name}
        value={writerPolicyTriState(props.flag)}
        onChange={(event) => {
          (event.currentTarget as HTMLSelectElement).form?.submit();
        }}
      >
        <option value="inherit">{defaultChoiceLabel(props.flag)}</option>
        <option value="include">include</option>
        <option value="exclude">exclude</option>
      </select>
    </label>
  );
}

export function WriterPolicyControls(props: {
  writerPolicy: OutputWriterPolicyProjection;
  hiddenFields: ComponentChildren;
}) {
  return (
    <form method="post" class="writer-policy-form">
      {props.hiddenFields}
      <input type="hidden" name="action" value="set-writer-overrides" />
      <WriterPolicySelect
        label="Commentary"
        name="commentary"
        flag={props.writerPolicy.commentary}
      />
      <WriterPolicySelect
        label="Thinking"
        name="thinking"
        flag={props.writerPolicy.thinking}
      />
    </form>
  );
}
