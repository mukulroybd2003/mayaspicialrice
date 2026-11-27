/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-8d0d8005'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "pwa-maskable-512x512.png",
    "revision": "6bc53d2fd902c2a9cc43c7596824165a"
  }, {
    "url": "pwa-512x512.png",
    "revision": "b373cb89913c6f29ec5a8a78b293941d"
  }, {
    "url": "pwa-192x192.png",
    "revision": "621d191c30fbdfd40fb92243df411df9"
  }, {
    "url": "index.html",
    "revision": "322952f85b30bb29c9b779af61d82434"
  }, {
    "url": "icon.svg",
    "revision": "23fc087a163113da497be14df6effa0d"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "93077b140b5fcd182e55ef7595cfecc9"
  }, {
    "url": "assets/workbox-window.prod.es5-Bd17z0YL.js",
    "revision": null
  }, {
    "url": "assets/web-C9Qqp2jM.js",
    "revision": null
  }, {
    "url": "assets/web-C63oOrNa.js",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-latin-ext-400-normal-hEpVi6du.woff2",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-latin-ext-400-normal-BBcU6JF0.woff",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-latin-400-normal-DSiOXPjq.woff",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-latin-400-normal-1lYSvEyl.woff2",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-bengali-400-normal-v3lAayBG.woff2",
    "revision": null
  }, {
    "url": "assets/tiro-bangla-bengali-400-normal-CIbHCMPl.woff",
    "revision": null
  }, {
    "url": "assets/purify.es-Dzkdzyfv.js",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-vietnamese-700-normal-CV6qDkkj.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-vietnamese-700-normal-BCh_uG_5.woff",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-vietnamese-600-normal-Y4VTTRme.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-vietnamese-600-normal-5YsyKbU1.woff",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-ext-700-normal-BajbvANd.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-ext-700-normal-8-d-IyIQ.woff",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-ext-600-normal-DQgPU_Cg.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-ext-600-normal-B0WRRYJ1.woff",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-700-normal-DqEcQeE5.woff",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-700-normal-CfpNZvy6.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-600-normal-DLTa1BUW.woff2",
    "revision": null
  }, {
    "url": "assets/plus-jakarta-sans-latin-600-normal-BR_Ojra4.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-700-normal-BMiYGHX_.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-700-normal-3-Al-97M.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-600-normal-DY6HLMBa.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-600-normal-C6cBZc4J.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-500-normal-_4HAyqfX.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-500-normal-5mg23k2Y.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-400-normal-DwoTidnb.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-ext-400-normal-Caj59Max.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-700-normal-DcY8RmmN.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-700-normal-CBJkAOMM.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-600-normal-KNvJZft-.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-600-normal-BokLars8.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-500-normal-D2CGPErm.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-500-normal-CcYSFWJv.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-400-normal-DiV_iq0_.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-latin-400-normal-BNmU3xSe.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-700-normal-DXVjD8fr.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-700-normal-C0v9szhP.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-600-normal-d2kw9WWz.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-600-normal-BVnGrJcL.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-500-normal-Dog8gTkV.woff2",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-500-normal-BZbfyIWS.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-400-normal-BymQv2v6.woff",
    "revision": null
  }, {
    "url": "assets/noto-sans-bengali-bengali-400-normal-BFibWJDZ.woff2",
    "revision": null
  }, {
    "url": "assets/index.es-DTyi7b5E.js",
    "revision": null
  }, {
    "url": "assets/index-BQrDncYW.js",
    "revision": null
  }, {
    "url": "assets/index-BB4aTMgl.css",
    "revision": null
  }, {
    "url": "assets/html2canvas-BOoJlk4H.js",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-700-normal-CJIcxD6K.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-700-normal-BLI3TTWz.woff",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-500-normal-DR84L5F-.woff",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-500-normal-BJfUCQsA.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-400-normal-BtiwyxMk.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-ext-400-normal-BjWJ59Pq.woff",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-700-normal-DvUfVpUG.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-700-normal-CUSSCpQX.woff",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-500-normal-Dr3UlScf.woff",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-500-normal-B9HHJjqV.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-400-normal-CW0RaeGs.woff2",
    "revision": null
  }, {
    "url": "assets/dm-sans-latin-400-normal-BwCSEQnW.woff",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "93077b140b5fcd182e55ef7595cfecc9"
  }, {
    "url": "icon.svg",
    "revision": "23fc087a163113da497be14df6effa0d"
  }, {
    "url": "pwa-192x192.png",
    "revision": "621d191c30fbdfd40fb92243df411df9"
  }, {
    "url": "pwa-512x512.png",
    "revision": "b373cb89913c6f29ec5a8a78b293941d"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "6bc53d2fd902c2a9cc43c7596824165a"
  }, {
    "url": "manifest.webmanifest",
    "revision": "2846306892715594172540d428bde742"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//]
  }));
  workbox.registerRoute(/^\/api\/v1\/.*/i, new workbox.NetworkFirst({
    "cacheName": "api-v1-cache",
    "networkTimeoutSeconds": 4,
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 60,
      maxAgeSeconds: 604800
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.googleapis\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.gstatic\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "gstatic-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
