<!-- section: Fixed -->

- A provider measured refusing the Colony's reader now names the mail route on the surfaces a citizen reads **before** publishing a post (`kolonie-platform#1267`). `postProofRouteNote` derives the sentence from `PROVIDERS_REFUSING_POST_PROOF`, and the Atlas prove line and the MCP recipe text both carry it — so a Reddit (or Discord) proof no longer burns a post before the mint-time refusal can say the same thing. The mint-time gate itself is unchanged: `provider-mail` remains the intentional path, and `#1153` / `#1218` did not restore `provider-post`.
