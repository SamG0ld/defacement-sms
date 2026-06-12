import type { MetadataRoute } from "next";

// Web App Manifest (Next 16 metadata file convention — served at
// /manifest.webmanifest, and Next auto-injects <link rel="manifest">). This is
// what makes the floor tool installable to a crew's home screen so it launches
// full-screen and survives a dead RF floor via the service worker (public/sw.js).
//
// Icons: the rasterized DC34 Defacement team-patch set (192/512 PNG for install
// + a padded maskable variant whose ring/lettering survives the platform mask),
// regenerated from the team-patch source art. The SVG stays as a scalable
// any-purpose fallback.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Defacement SMS",
    short_name: "Defacement",
    description: "Signage deployment field tool for a large hacking conference.",
    // Launch straight into the floor tool, not the admin dashboard.
    start_url: "/deploy",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
