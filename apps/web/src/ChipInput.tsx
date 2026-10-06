import { useCallback, useMemo, useState } from "react";

/**
 * Tag / chip input for multiple free-text values.
 *
 * Replaces comma-separated free-text fields that invite typos with no feedback.
 * Values can be added by typing and pressing Enter or comma, or pasted as a comma list.
 * Invalid values show an inline error and are not added.
 */
type ChipInputProps = {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  validate?: (value: string) => string | null;
  disabled?: boolean;
};

export function ChipInput({ id, values, onChange, placeholder, validate, disabled }: ChipInputProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      if (values.includes(trimmed)) {
        setError(`${trimmed} is already added.`);
        return;
      }
      if (validate) {
        const msg = validate(trimmed);
        if (msg) {
          setError(msg);
          return;
        }
      }
      onChange([...values, trimmed]);
      setError(null);
    },
    [onChange, validate, values]
  );

  const remove = (value: string) => {
    onChange(values.filter((v) => v !== value));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(input);
      setInput("");
      return;
    }
    if (e.key === "Backspace" && input === "" && values.length > 0) {
      remove(values[values.length - 1]!);
    }
    if (e.key === "," || e.key === " ") {
      // Space also commits when there is a partial token; comma always commits.
      e.preventDefault();
      add(input);
      setInput("");
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (text.includes(",")) {
      e.preventDefault();
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(add);
      setInput("");
    }
  };

  return (
    <div className="chip-input" aria-disabled={disabled}>
      <div className="chip-input__box">
        {values.map((v) => (
          <span key={v} className="chip-input__chip">
            {v}
            <button
              type="button"
              className="chip-input__remove"
              aria-label={`Remove ${v}`}
              onClick={() => remove(v)}
              disabled={disabled}
              tabIndex={-1}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (input.trim()) { add(input); setInput(""); } }}
          placeholder={values.length === 0 ? placeholder : ""}
          disabled={disabled}
          aria-invalid={error ? "true" : "false"}
        />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export function useCommaList(values: string[], onChange: (values: string[]) => void) {
  const text = useMemo(() => values.join(", "), [values]);
  const setText = (next: string) => {
    onChange(next.split(",").map((s) => s.trim()).filter(Boolean));
  };
  return [text, setText] as const;
}
