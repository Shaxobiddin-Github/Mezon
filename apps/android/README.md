# Guzar Kassa — Android (T4.4)

Telefon yoki planshet **ikkinchi kassa** bo'lib ishlaydi: o'z bazasi yo'q, hamma narsa
do'kondagi asosiy kassada (kompyuterda) saqlanadi. Ekran — kompyuter kassasidagi o'sha React UI.

## Qanday ishlaydi

- Asosiy kassada: **Sozlamalar → Ulanishlar → Kassa qo'shish**. Kod, manzil (IP) va barmoq izi chiqadi.
- Telefonda birinchi ochilganda faqat ulanish oynasi chiqadi: IP, port (47821) va kodni kiriting.
  Ikkala ekrandagi barmoq izi bir xil bo'lishi kerak.
- Telefon asosiy kassaga do'kon Wi-Fi'si orqali, **sertifikat barmoq izi bilan qadalgan TLS** orqali
  ulanadi (ikkinchi kompyuter kassasi bilan bir xil protokol, `packages/drivers/src/node/pinned-https.ts`).
- Terminal kaliti faqat Android tomonda (`TerminalStore`, Android Keystore AES-GCM bilan shifrlangan)
  saqlanadi va JavaScript'ga hech qachon chiqmaydi. Zaxira nusxaga (backup) tushmaydi.
- Sotuv ekranida **Kamera** tugmasi: shtrix-kodni telefon kamerasi bilan o'qiydi (Google ML Kit).

## Tuzilishi

| Fayl                                                           | Vazifasi                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/bridge.ts`                                                | `window.mezonBridge` (Android) va `fetch` shimi: virtual `http://127.0.0.1:47999` so'rovlari native plaginga boradi |
| `src/virtual-hub.ts`                                           | virtual manzil tekshiruvi va javobni `Response` ga aylantirish (testlangan)                                         |
| `android/app/src/main/java/uz/guzar/kassa/MezonHubPlugin.java` | `info / pair / leave / request / restart`                                                                           |
| `android/.../LanTls.java`                                      | qadalgan TLS, ulanish isboti (HMAC), barmoq izi formati                                                             |
| `android/.../TerminalStore.java`                               | terminal kalitini shifrlab saqlash                                                                                  |

## Yig'ish

JDK 21 va Android SDK kerak (`JAVA_HOME`, `ANDROID_HOME` yoki `android/local.properties`).

```
pnpm turbo run build --filter=@mezon/android...
pnpm --filter @mezon/android run apk
```

APK: `apps/android/android/app/build/outputs/apk/debug/app-debug.apk`. CI har PR'da shu APK'ni
`guzar-kassa-android-debug-apk` artefakti sifatida beradi.
