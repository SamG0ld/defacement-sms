import { expect, test } from "@playwright/test";

// Unauthenticated smoke: the app boots and the auth gate behaves. No OAuth.

test("landing door renders on /login", async ({ page }) => {
  // Bare /login (no query) opens on the landing — the public "door". The CTA is
  // now "Tap to authenticate"; "Goons Only Beyond This Point" is the threshold
  // body text (a <p>, no longer the button's accessible name).
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: /tap to authenticate/i }),
  ).toBeVisible();
  await expect(
    page.locator("p", { hasText: /goons only beyond this point/i }),
  ).toBeVisible();
});

test("the sign-in surface renders the Google sign-in", async ({ page }) => {
  // A deep-link / auth-gate bounce (the proxy appends ?callbackUrl=) skips the
  // placard straight to the sign-in panel.
  await page.goto("/login?callbackUrl=/");
  await expect(
    page.getByRole("button", { name: /continue with google/i }),
  ).toBeVisible();
});

test("unauthenticated access to a protected route redirects to /login", async ({
  page,
}) => {
  await page.goto("/signs");
  await expect(page).toHaveURL(/\/login/);
});
