# migrate/ — one-shot Run 2 tooling

These scripts mechanically extracted the tested warehouse workflows from the
legacy prototype (`floorguard-prototype`) and merged them into this app's
`app.js`. They already ran; they are kept only as an audit trail of what was
ported and how. Do not re-run them against this repo.

- `extract.py` — pulled the reviewed line ranges out of the prototype's `app.js`
- `port-raw.js` — the raw extracted code before route renames
- `check-comments.py` — verified block-comment balance after the merge
- `hub-screens.js` — the hub screens (Cycle Count, Cut/Roll Tracking, Work Orders)
  as merged; the live copies now live in `app.js`
