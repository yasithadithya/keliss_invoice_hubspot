# Rep photos and signatures

Files here are referenced from `reps.json` by path and are baked into the Docker
image, so nothing depends on a File Manager URL staying alive.

```json
"75446568": {
  "name": "HAS Jayahe",
  "initials": "HJ",
  "title": "Export sales",
  "photoUrl": "assets/reps/hj-photo.jpg",
  "signatureUrl": "assets/reps/hj-signature.png"
}
```

A full `https://…` URL still works in those fields; anything else is read from disk,
relative to the repo root. Accepted: `.png` `.jpg` `.jpeg` `.webp` `.gif` `.svg`.

| | Prints as | Make it |
|---|---|---|
| `photoUrl` | 18 mm circle, cropped to fill | Square, at least 400×400, JPG or PNG. Face centred — the crop is a circle. |
| `signatureUrl` | 12 mm tall, on the dark navy band | **PNG with a transparent background.** |

The signature is recoloured to solid white (`brightness(0) invert(1)`) so it reads on
the navy band. A JPG, or a PNG with a white background, turns into a white block —
the background must be transparent. Scan or photograph the signature, cut the
background out, and save as PNG.

Leave a field `null` and the invoice falls back:

- **`photoUrl`** → the rep's HubSpot profile picture, fetched from the same public
  avatar URL the CRM uses. It is only 80×80, so add a file here when a rep should
  look sharp. No photo in HubSpot either → the sand initials tile.
- **`signatureUrl`** → the rep's typed name. HubSpot holds no signature, so a file
  here is the only way to print a real one.
