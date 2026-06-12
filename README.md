# OriginFlow

The fast loan-officer workspace that sits in front of your system of record.
Built solo by a Navy veteran in Lubbock, TX.

**Live site:** [originflowlos.com](https://originflowlos.com)

## What this is

OriginFlow is where loan officers start and run the loan: files open in
seconds, AI document extraction reads paystubs and clears conditions
automatically, and the finished file exports as MISMO 3.4 XML into
Encompass or whatever system of record your shop already runs. Nothing to
rip out, nothing to re-key.

## Stack

Vanilla HTML/JS served from GitHub Pages behind Cloudflare. Backend is
Supabase: Postgres with row-level security, Auth, Realtime, Storage, and
Deno edge functions. Document extraction runs Claude (Haiku
classification, Sonnet field extraction). Billing through Stripe, email
through Resend. No framework, no build step — deliberately.

## Status

Onboarding the first Texas branches now. $400/branch/month + $25 per
closed loan, listed publicly, no sales call.

## Founder

Davis Rackler · [@DRackler](https://twitter.com/DRackler) · Navy veteran ·
Texas Tech BBA-IT Systems · also operates
[Submarine Catalyst](https://submarinecatalyst.com), a biotech
intelligence platform with paying customers.

Questions: dsrackler@gmail.com
