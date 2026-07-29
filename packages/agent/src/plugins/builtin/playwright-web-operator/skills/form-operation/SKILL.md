# Form Operation

Fill forms, upload files, and submit. Form submission is the most
common way a browser mutates external state, so this skill is strict
about confirmation boundaries.

## When to use

- The user says "fill out this form" / "submit the application" /
  "upload the file to ...".
- A workflow requires a login that is not yet cached in the browser
  profile.
- You need to test a form's validation behavior by submitting
  specific values.

## Process

1. `browser_navigate` to the form page. Take a `browser_snapshot` to
   map field `ref`s to labels.
2. Match each user-provided value to a form field. Prefer
   `browser_fill_form` (batch fill) over individual `browser_type`
   calls — fewer round trips and the MCP server validates types.
3. For `<select>` elements, `browser_select_option` with the option
   value or label. Do not assume the visible text matches the value.
4. For file inputs, `browser_file_upload` with an absolute path.
   Verify the file exists locally first.
5. Before submit, show the user a summary of every field-value pair
   about to be sent. Wait for confirmation.
6. Submit with `browser_click` on the submit button, or
   `browser_press_key` with `Enter` if the form supports it.
7. After submit, `browser_snapshot` to confirm the result page or
   error messages. Report success or paste the error text.

## Tool call patterns

- `browser_fill_form` accepts a map of `ref -> value`. Use it for
  forms with more than two fields.
- `browser_type` is for single-field input or when the field requires
  per-keystroke behavior (e.g. autocomplete that fires on input).
- `browser_file_upload` takes the input element `ref` and a path on
  disk. Relative paths resolve from the MCP server's CWD, not the
  workspace — use absolute paths.

## Confirmation boundary

- Reading the form (snapshot, list fields): `read` tier, automatic.
- Typing into a field on a public page: `write` tier, confirm. Even
  a single keystroke can trigger an autosubmit.
- File upload: `modify` tier, confirm. Files can contain sensitive
  data and uploads are often irreversible.
- Form submit: `modify` tier, confirm. Always show the full set of
  field values before submitting.
- Destructive confirmations (e.g. "Yes, delete my account" dialogs):
  `destructive` tier, strong confirmation.

## Pitfalls

- Hidden fields (CSRF tokens, hidden inputs) should not be filled —
  the server expects its own value. Skip them in `browser_fill_form`.
- Autocomplete dropdowns may steal focus. Use `browser_press_key`
  with `Escape` after typing to dismiss them.
- Some forms submit on `Enter` even when a submit button exists.
  Avoid `browser_press_key Enter` until you have confirmed the form
  is ready.
- Login forms are sensitive — never log in without explicit user
  confirmation, and prefer the user's existing browser profile over
  typing credentials into chat.
