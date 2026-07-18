import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  capabilityCell: css`
    min-width: 220px;
  `,
  content: css`
    overflow-y: auto;
    padding: 20px clamp(16px, 3vw, 32px) 32px;
  `,
  empty: css`
    padding: 40px 16px;
    color: ${cssVar.colorTextSecondary};
    text-align: center;
  `,
  headerTitle: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
  `,
  metric: css`
    min-height: 92px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
    padding: 14px 16px;
  `,
  metricLabel: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 700;
  `,
  metricSubtext: css`
    overflow: hidden;
    margin-top: 8px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  metricValue: css`
    margin-top: 8px;
    color: ${cssVar.colorText};
    font-size: 28px;
    font-weight: 750;
    line-height: 1;
  `,
  modelName: css`
    font-weight: 700;
    overflow-wrap: anywhere;
  `,
  muted: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    overflow-wrap: anywhere;
  `,
  page: css`
    height: 100%;
    background: ${cssVar.colorBgLayout};
  `,
  panel: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  score: css`
    color: ${cssVar.colorPrimary};
    font-size: 18px;
    font-variant-numeric: tabular-nums;
    font-weight: 750;
  `,
  summaryGrid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;

    @media (max-width: 920px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    @media (max-width: 560px) {
      grid-template-columns: 1fr;
    }
  `,
  table: css`
    width: 100%;
    min-width: 1040px;
    border-collapse: collapse;
    table-layout: fixed;

    th,
    td {
      border-bottom: 1px solid ${cssVar.colorBorderSecondary};
      padding: 12px;
      text-align: left;
      vertical-align: top;
    }

    th {
      background: ${cssVar.colorFillQuaternary};
      color: ${cssVar.colorTextSecondary};
      font-size: 12px;
      font-weight: 700;
    }

    tbody tr:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  tableWrap: css`
    overflow-x: auto;
  `,
  toolbar: css`
    display: grid;
    grid-template-columns: minmax(220px, 1fr) 180px 170px 170px;
    gap: 10px;

    @media (max-width: 920px) {
      grid-template-columns: 1fr 1fr;
    }

    @media (max-width: 560px) {
      grid-template-columns: 1fr;
    }
  `,
}));
