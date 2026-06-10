import { expect, test } from "@playwright/test";

// Unauthenticated smoke: the app boots and the auth gate behaves. No OAuth.

test("login page renders the Google sign-in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Defacement SMS")).toBeVisible();
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
