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

## Ikki bajaruvchi (2026-11-16 dan)

| Yo'lak | Bajaruvchi | Branch | Topshiriq | Hisobot |
|---|---|---|---|---|
| A: F2 sinxronlash, keyin F4 | Gemini | `gemini/...` | `.mezon/claude/TOPSHIRIQ.md` | `.mezon/gemini/HISOBOT.md` |
| B: F3 (hujjatsiz qismlar), keyin F5 | ishchi2 (Claude Code) | `ishchi2/...` | `.mezon/claude/TOPSHIRIQ-ishchi2.md` | `.mezon/ishchi2/HISOBOT.md` |

Ikkinchi ishchining to'liq yo'riqnomasi `.mezon/ISHCHI2.md` da. Har bajaruvchi faqat o'z fayllariga yozadi. Umumiy fayllardagi (sxema registri, migratsiyalar) to'qnashuvlarni merge'dan oldin rebase bilan hal qiladi. Merge tartibini nazoratchi belgilaydi.
