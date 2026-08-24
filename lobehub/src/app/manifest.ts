import { type MetadataRoute } from 'next';

const manifest = async (): Promise<MetadataRoute.Manifest> => {
  // Skip heavy module compilation in development
  if (process.env.NODE_ENV === 'development') {
    return {
      background_color: '#000000',
      description: 'ModelNet Development',
      display: 'standalone',
      icons: [
        {
          sizes: '192x192',
          src: '/icons/icon-192x192.png',
          type: 'image/png',
        },
      ],
      name: 'ModelNet',
      short_name: 'ModelNet',
      start_url: '/',
      theme_color: '#000000',
    };
  }

  const [{ BRANDING_NAME }, { kebabCase }, { manifestModule }] = await Promise.all([
      import('@lobechat/business-const'),
      import('es-toolkit/compat'),
      import('@/server/manifest'),
    ]);

  // @ts-expect-error - manifestModule.generate returns extended manifest with custom properties
  return manifestModule.generate({
    description: `${BRANDING_NAME} - 暨南大学 WNDS 实验室智能工作平台`,
    icons: [
      {
        purpose: 'any',
        sizes: '192x192',
        url: '/icons/icon-192x192.png',
      },
      {
        purpose: 'maskable',
        sizes: '192x192',
        url: '/icons/icon-192x192.maskable.png',
      },
      {
        purpose: 'any',
        sizes: '512x512',
        url: '/icons/icon-512x512.png',
      },
      {
        purpose: 'maskable',
        sizes: '512x512',
        url: '/icons/icon-512x512.maskable.png',
      },
    ],
    id: kebabCase(BRANDING_NAME),
    name: BRANDING_NAME,
    screenshots: [],
  });
};

export default manifest;
