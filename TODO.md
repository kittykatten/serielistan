# Att göra längre fram

## Nästa version
- Startsidan: ta bort knappen "Help me pick" uppe till höger (Help me pick finns i menyn).
- Settings bara under K (avataren): ta bort Settings ur sidomenyn och ur More på mobilen.
- Settings: Labels och Streaming services går att fälla ihop och ut (ihopfällda från början).
- Serier: raden Length på seriesidan ska också visa avsnittslängd, t.ex. "16 episodes · 58 min episodes · 15 h 25 min".
- Help me pick (Both of us): visa Up next-stjärnorna på förslagen, och stjärnknappen så att man kan sätta/ta bort stjärna direkt där.
  "Not tonight" (✕) ska finnas kvar bredvid stjärnan.
- Help me pick: "Not tonight" (✕) gäller till kl. 05 nästa morgon och sparas även om appen stängs (per enhet).
  I dag nollställs det när appen laddas om, eller med "bring back".
- Sedda filmer: fyll på rollista, trailer, länkar och nyckelord från TMDB automatiskt i bakgrunden (ett antal per start),
  så att sökningen hittar skådespelare även i sedda filmer.
- "Log as seen" direkt från sökningen.

## Senare
- Film: mål för 2027 – ett mängdmål och kvalitativa mål (typer av filmer). Plats finns på startsidan.
- Film: export till Letterboxd så att dagboken där kan hållas uppdaterad.
- Film: testa export i samma format som fliken "Sett" i kalkylarket "Film": Titel, Land, År, Genre (IMDB) ×3, Längd (h:mm),
  Medie (= Where), Sett (t.ex. "28 January 2020"), Betyg (1–10, = stjärnor × 2), Kommentar (= Note). Så att nya visningar kan klistras in i arket.

## Beslut som väntar
- Publikt repo: ta bort e-postadresserna ur firestore.rules (och historiken), eller flytta till Firebase Hosting med privat repo.

## Struket
- GFF-läge (tillförde inget utöver datum och "Use GFF…"-knappen som redan finns).

Arbetssätt: nya önskemål samlas här, byggs och testas i /beta/, och släpps sedan som en version.
