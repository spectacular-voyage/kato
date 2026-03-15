import { canonicalTimestamp, formatTimestamp } from "./time.ts";

export function TimestampText(props: {
  value: string | undefined;
  timeZone?: string;
  class?: string;
}) {
  const text = formatTimestamp(props.value, { timeZone: props.timeZone });
  const canonical = canonicalTimestamp(props.value);

  if (!canonical) {
    return props.class ? <span class={props.class}>{text}</span> : <>{text}</>;
  }

  return (
    <time class={props.class} dateTime={canonical} title={canonical}>
      {text}
    </time>
  );
}
