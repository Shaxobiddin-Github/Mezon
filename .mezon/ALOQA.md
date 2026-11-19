# Claude ↔ Gemini aloqa tartibi

Claude (ish boshqaruvchi va tekshiruvchi) va Gemini (bajaruvchi) shu papka orqali, git commitlari bilan gaplashadi. Egasi oraliqda turmaydi.

## Fayllar

| Fayl | Kim yozadi | Mazmuni |
|---|---|---|
| `.mezon/claude/TOPSHIRIQ.md` | Faqat Claude | Joriy topshiriq yoki xulosa (`QABUL` / `QAYTA ISHLASH`) |
| `.mezon/gemini/HISOBOT.md` | Faqat Gemini | Oxirgi hisobot (GEMINI.md 5-bo'lim shabloni) |
| `.mezon/kutish.mjs` | — | Claude javobini kutuvchi skript |

Gemini `TOPSHIRIQ.md` ni o'zgartirmaydi, Claude `HISOBOT.md` ni o'zgartirmaydi. Har yangi hisobot oldingisining ustiga yoziladi, tarix git'da qoladi.

## Gemini sikli

1. `git pull --ff-only` qil va `.mezon/claude/TOPSHIRIQ.md` ni o'qi.
2. Topshiriqni GEMINI.md qoidalari bo'yicha bajar: kod, testlar, `pnpm verify`, commit, push, PR, CI.
3. Hisobotni `.mezon/gemini/HISOBOT.md` ga yoz. `[gemini-hisobot] T0.x` xabari bilan commit va push qil. Kod commitlari ham push qilingan bo'lishi shart.
4. `node .mezon/kutish.mjs` ni ishga tushir. Skript Claude'ning yangi `TOPSHIRIQ.md` sini kutadi va kelganda uni ekranga chiqaradi.
5. Kelgan topshiriqni bajar va 2-qadamdan davom et.
6. Skript `VAQT TUGADI` desa, uni yana ishga tushir. Ketma-ket 3 marta javob kelmasa, to'xta va egasiga xabar ber.

## Qoidalar

- Claude `[claude]` bilan boshlanadigan commitlar qo'shadi. Ularni rebase qilma, o'chirma va qayta yozma.
- Ishni boshlashdan oldin va push'dan oldin `git pull --ff-only` qil. Ziddiyat bo'lsa, o'zingcha hal qilma: hisobotga yoz va to'xta.
- `QABUL` kelganda merge'ni `TOPSHIRIQ.md` dagi aniq ko'rsatma bo'yicha bajar. Keyingi vazifa ham shu faylda bo'ladi.
- Merge'da `.mezon/` fayllari `main`ga tushadi, bu normal holat.
- GEMINI.md 15-bo'limidagi egasi qarorlari egasida qoladi. Bunday qaror kerak bo'lsa, hisobotda so'ra va to'xta.

## Ikki ishchi (2026-11-17 dan, egasi qarori)

Gemini loyihadan chiqarildi. Ikki ishchi bor: **Claude** (nazoratchi, o'zi ham paket bajaradi) va **ishchi2** (Claude Code). Ish **katta paketlarda** bo'ladi: har paket uchun bitta reja, bitta branch va bitta PR. Ishchilar bir-birining PR'ini tekshiradi.

| Paket | Bajaruvchi | Ichida | Branch | Topshiriq | Hisobot |
|---|---|---|---|---|---|
| P1 | ishchi2 | T2.6, T2.5, bulut buyruq yozuvchi porti, fiskal test qarzi va `device_id` qoidasi | `ishchi2/...` | `.mezon/claude/TOPSHIRIQ-ishchi2.md` | `.mezon/ishchi2/HISOBOT.md` |
| P2 | ishchi2 | T3.6 UzQR va to'lov (Fake), T3.7 markirovka (Fake), T3.8 audit xesh zanjiri | `ishchi2/...` | shu | shu |
| P3 | ishchi2 | T4.1 LAN hub, T4.2 ko'p kassa, T4.3 terminal printeri, T2.8 yakuniy integratsiya | `ishchi2/...` | shu | shu |
| C1 | Claude | T2.7b kabinetdan yozish, T2.8 Telegram bot, T3.9 pilot hujjatlari | `claude/...` | — | `.mezon/claude/HISOBOT.md` |
| C2 | Claude | T4.4 Android va web-kassa, T4.7 obuna, T4.8 imzolangan yangilanish | `claude/...` | — | shu |
| C3 | Claude | F5: T5.1–T5.4, T5.6 | `claude/...` | — | shu |

**O'zaro tekshiruv:**
- Tekshiruv so'rovi `TOPSHIRIQ-ishchi2.md` dagi `## Tekshiruv so'rovi: PR #N` bo'limi orqali keladi.
- ishchi2 xulosasi `.mezon/ishchi2/TEKSHIRUV.md` ga, `[ishchi2-tekshiruv] PR #N` commit'i bilan, o'sha PR'ning branch'iga yoziladi.
- Natija: `QABUL`, `SHARTLI QABUL` yoki `QAYTA ISHLASH`.
- Merge faqat tekshiruvchining QABULi va yashil CI'dan keyin bo'ladi.

**Qoidalar:**
- `main` faqat **merge** bilan yangilanadi, rebase qilinmaydi.
- Migratsiya raqamlari to'qnashsa, kim keyin merge bo'lsa, `main` ni merge qilib raqamni o'sha qayta yaratadi.
- `TOPSHIRIQ.md` va `gemini/HISOBOT.md` endi ishlatilmaydi, tarix uchun qoldirilgan.
