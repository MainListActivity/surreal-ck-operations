# Figma Make setup notes

## Deployment

Bootstrap uses the credential-free `owner-end` design demo and is verified.
Deploy preview is explicitly skipped because that demo requires a Bun runtime
server.

Production `owner-end` is a Cloudflare Worker whose static UI depends on its
`/api` routes. It does not produce a complete static artifact that can be
safely published with Figma Make's static adapter. Creating a static deploy
script for `owner-end/public` would publish a broken primary experience, so
`.figma/make/deploy` is intentionally not configured and
`figma make verify-deploy` remains blocked.

Continue to use the repository's documented Cloudflare Worker deployment
process for production. A Figma deploy would require a separately authorized
application/runtime migration outside this initial setup task.
