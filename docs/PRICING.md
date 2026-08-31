# What a minute actually costs

Measured on the reference deployment, mid 2026, at roughly 85 INR to 1 USD.
Assumes the agent speaks for about half of each minute, which is typical for a
receptionist that keeps turns to one or two sentences.

| Layer | Provider | Rate | Per minute |
|---|---|---|---|
| Telephony | Vobiz | ~0.70 INR/min | 0.70 INR |
| Speech to text | Deepgram nova-3 | $0.0077/min | 0.50 INR |
| Brain | Groq llama-3.3-70b | per token | ~0.12 INR |
| Voice | Rumik mulberry, promo | 0.50 INR/1k chars | ~0.25 INR |
| **Total, promo** | | | **~1.6 INR/min** |
| Voice | Rumik mulberry, permanent | 2.50 INR/1k chars | ~1.25 INR |
| **Total, permanent** | | | **~2.6 INR/min** |

Fixed costs: a Vobiz number is 500 INR/month, and the VPS is about $6 to $12/month
depending on size.

## Against the usual stack

An ElevenLabs plus Twilio plus GPT-4 setup lands around 15 to 20 INR/min. Nearly
all of the gap is the voice: ElevenLabs v3 is roughly 10,000 INR per million
characters against Rumik mulberry at 500 INR promo and 2,500 INR permanent, so
20x cheaper on promo and 4x permanent.

## Margin at real volume

At 3,500 minutes/month against a 40,000 INR/month retainer:

| | Promo | Permanent |
|---|---|---|
| COGS | ~5,600 INR | ~9,100 INR |
| Gross margin | 86% | 78% |

## Claim discipline

"AI voice agents from 1 rupee a minute" is defensible: the AI layer alone
(STT + brain + voice) is about 0.90 INR/min on promo rates.

Do NOT claim 1 rupee a minute all-in. With carrier minutes it is 1.6 to 2.6
INR/min, and anyone who checks will find that immediately.
