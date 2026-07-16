'use client';

import { type ComponentProps } from 'react';
import { memo } from 'react';

import CustomLogo from './Custom';

interface ProductLogoProps extends ComponentProps<typeof CustomLogo> {
  height?: number;
  width?: number;
}

export const ProductLogo = memo<ProductLogoProps>((props) => <CustomLogo {...props} />);
