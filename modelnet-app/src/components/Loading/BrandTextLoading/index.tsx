import { BRANDING_LOGO_URL, BRANDING_NAME } from '@lobechat/business-const';
import { BrandLoading, type BrandLoadingProps } from '@lobehub/ui/brand';

import { isCustomBranding } from '@/const/version';

import CircleLoading from '../CircleLoading';
import styles from './index.module.css';

interface BrandTextLoadingProps {
  debugId: string;
}

const ModelNetText: BrandLoadingProps['text'] = ({ className, size = 40, style }) => (
  <span
    className={className}
    style={{
      flex: 'none',
      fontSize: typeof size === 'number' ? Math.round(size * 0.62) : size,
      fontWeight: 700,
      letterSpacing: 0,
      lineHeight: 1,
      ...style,
    }}
  >
    ModelNet
  </span>
);

const BrandTextLoading = ({ debugId }: BrandTextLoadingProps) => {
  if (isCustomBranding)
    return (
      <div className={styles.container}>
        <div aria-label="Loading" className={styles.customBrand} role="status">
          {BRANDING_LOGO_URL ? (
            <img alt="" className={styles.customLogo} src={BRANDING_LOGO_URL} />
          ) : (
            <CircleLoading />
          )}
          <span className={styles.customText}>{BRANDING_NAME}</span>
        </div>
      </div>
    );

  const showDebug = process.env.NODE_ENV === 'development' && debugId;

  return (
    <div className={styles.container}>
      <div aria-label="Loading" className={styles.brand} role="status">
        <BrandLoading size={40} text={ModelNetText} />
      </div>
      {showDebug && (
        <div className={styles.debug}>
          <div className={styles.debugRow}>
            <code>Debug ID:</code>
            <span className={styles.debugTag}>
              <code>{debugId}</code>
            </span>
          </div>
          <div className={styles.debugHint}>only visible in development</div>
        </div>
      )}
    </div>
  );
};

export default BrandTextLoading;
