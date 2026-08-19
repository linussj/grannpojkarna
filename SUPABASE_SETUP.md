# Koppla Grannpojkarna till Supabase

## 1. Skapa projektet

Skapa ett gratis projekt i Supabase. Öppna sedan **SQL Editor**, klistra in hela
innehållet i `supabase-setup.sql` och kör skriptet en gång.

## 2. Ställ in inloggning med sexsiffrig kod

I Supabase öppnar du **Authentication → Email Templates → Magic Link**. Byt
länken i mallen mot tokenvariabeln `{{ .Token }}` så att mejlet visar en kod.

Sätt **Site URL** till `https://grannpojkarna.se` under Authenticationens URL-
inställningar.

## 3. Lägg in webbplatsens publika anslutning

Öppna projektets **Connect**-dialog och kopiera:

- Project URL
- Publishable key

Lägg in dem i `config.js`. Använd aldrig `service_role`, secret key eller
databaslösenord i webbplatsens filer.

## 4. Mejlleverans för pilot

Supabases standardmejl är endast till för test. Koppla Resends kostnadsfria SMTP
innan riktiga användare bjuds in. Verifiera helst en separat sändande subdomän,
exempelvis `auth.grannpojkarna.se`, så att webbplatsens befintliga DNS-poster inte
påverkas.

## 5. Uppdatering för jobblista och utförarprofiler

Om den första databasversionen redan är installerad kör du hela innehållet i
`supabase-migration-2.sql` en gång i Supabases SQL Editor. Uppdateringen:

- skiljer på privatperson/företag och beställare/utförare,
- gör öppna jobb synliga i den publika jobblistan,
- skapar intresseanmälningar för utförare,
- skapar den privata tabellen `callback_requests` för uppringningsförfrågningar.

Uppringningsförfrågningarna kan endast skickas in från webbplatsen. De kan inte
läsas publikt och hanteras tills vidare via Table Editor i Supabase.

## 6. Senare funktionsuppdateringar

Kör migreringarna i nummerordning om de inte redan är installerade:

- `supabase-migration-3.sql`: profilbilder, matchning, betyg och intjänat.
- `supabase-migration-4.sql`: frivillig korttidstillgänglighet för utförare.
- `supabase-migration-5.sql`: statusarna accepterat/pågående/klart samt privat jobbchatt.
- `supabase-migration-6.sql`: notiscenter för intresseanmälningar, valda utförare, jobbstatus, chatt och ersättning klar för utbetalning.

Migration 5 gör jobbflödet låst till **Öppet → Accepterat → Pågående → Klart**.
Endast beställaren kan bekräfta ett pågående jobb som klart. Chatten kan bara
läsas av jobbets beställare och valda utförare.
