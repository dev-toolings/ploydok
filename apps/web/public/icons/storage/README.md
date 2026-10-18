# Storage provider SVG assets

Downloaded SVG artwork for the storage destination picker. See `sources.json` for each download URL, reference page and SHA-256 checksum. SVG files are preserved as downloaded.

Service icons are used for Amazon S3, Cloudflare R2, Azure Blob Storage and Google Cloud Storage. Backblaze B2 and DigitalOcean Spaces use their provider logos. MinIO and Garage have separate files even though the picker currently groups them together.

The Google Cloud asset comes from `Unique Icons/Cloud Storage/SVG/Cloud_Storage-512-color.svg` inside the official core product icon ZIP.

These third-party marks retain their respective owners' rights and usage guidelines. They are not relicensed under the application license. Community collections are identified as download sources, not presented as official vendor publications.

There is no brand logo for generic S3-compatible storage or this server's disk. Keep generic interface icons for those entries.

`apps/web/src/components/storage/ProviderMark.tsx` uses these local assets in the destination picker and storage destination list. The combined MinIO / Garage preset displays both logos. Brand tiles use a white background in both themes to preserve the downloaded artwork's contrast and colors; generic entries retain the interface's panel tokens.
