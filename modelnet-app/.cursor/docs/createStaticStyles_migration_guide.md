# createStaticStyles 迁移指南

## 📖 概述

`createStaticStyles` 是 `antd-style` 提供的静态样式创建函数，相比 `createStyles`（hook 方案）具有零运行时开销的优势。样式在模块加载时计算一次，而不是每次组件渲染时计算。

## 🎯 适用场景

### ✅ 可以优化的场景

1. **纯静态样式**：不依赖运行时动态值
2. **使用标准 token**：所有 token 都在 `cssVar.json` 中有对应项
3. **简单的条件逻辑**：可以通过静态样式拆分处理

### ❌ 无法优化的场景

1. **JS 计算函数**：`readableColor()`, `chroma()`, `mix()`, `calc()` 中使用 token 数值
2. **复杂的动态 props**：需要运行时计算的复杂逻辑
3. **动态 prefixCls**：需要运行时传入的类名前缀（但可以硬编码为 `'ant'`）

## 🔄 基本转换步骤

### 1. 样式文件转换

**之前（createStyles）：**

```typescript
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => {
  return {
    root: css`
      color: ${token.colorText};
      font-size: ${token.fontSize}px;
    `,
  };
});
```

**之后（createStaticStyles）：**

```typescript
import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    root: css`
      color: ${cssVar.colorText};
      font-size: ${cssVar.fontSize};
    `,
  };
});
```

### 2. 组件文件转换

**之前：**

```typescript
import { useStyles } from './style';

const Component = () => {
  const { styles, cx } = useStyles();
  return <div className={cx(styles.root, className)} />;
};
```

**之后：**

```typescript
import { cx } from 'antd-style';
import { styles } from './style';

const Component = () => {
  return <div className={cx(styles.root, className)} />;
};
```

## 🛠️ 常见场景处理

### 场景 1: Token 转换

**规则：**

- `token.xxx` → `cssVar.xxx`
- 注意：`cssVar.fontSize` 已经包含 `px` 单位，不需要再加 `px`

**示例：**

```typescript
// ❌ 错误
font-size: ${cssVar.fontSize}px;  // cssVar.fontSize 已经是 "14px"

// ✅ 正确
font-size: ${cssVar.fontSize};     // 直接使用
```

**特殊情况 - calc ()：**

```typescript
// ❌ 错误
calc(${token.fontSize}px * 2.5)

// ✅ 正确
calc(${cssVar.fontSize} * 2.5)    // cssVar.fontSize 已经包含单位
```

### 场景 2: 动态 Props → CSS 变量

**适用：** 数值、字符串类型的 props

**步骤：**

1. 在样式文件中使用 CSS 变量（带默认值）
2. 在组件中通过 `style` prop 设置 CSS 变量

**示例：**

**样式文件：**

```typescript
export const styles = createStaticStyles(({ css }) => {
  return {
    root: css`
      width: var(--component-size, 24px);
      height: var(--component-size, 24px);
    `,
  };
});
```

**组件文件：**

```typescript
import { useMemo } from 'react';

const Component = ({ size = 24, style, ...rest }) => {
  const cssVariables = useMemo<Record<string, string>>(
    () => ({
      '--component-size': `${size}px`,
    }),
    [size],
  );

  return (
    <div
      className={styles.root}
      style={{
        ...cssVariables,
        ...style,
      }}
      {...rest}
    />
  );
};
```

**已优化示例：**

- `Video`: `maxHeight`, `maxWidth`, `minHeight`, `minWidth`
- `ScrollShadow`: `size`
- `MaskShadow`: `size`
- `ColorSwatches`: `size`
- `Grid`: `rows`, `maxItemWidth`, `gap`
- `Layout`: `headerHeight`
- `Footer`: `contentMaxWidth`

### 场景 3: 布尔值 Props → 静态样式拆分

**适用：** 简单的布尔值 props（2-3 个）

**步骤：**

1. 创建所有可能的组合样式
2. 运行时使用 `cx` 组合

**示例：**

**样式文件：**

```typescript
export const styles = createStaticStyles(({ css }) => {
  return {
    root: css`
      /* base styles */
    `,
    root_closable_true: css`
      /* closable styles */
    `,
    root_closable_false: css`
      /* no closable styles */
    `,
    root_hasTitle_true: css`
      /* has title styles */
    `,
    root_hasTitle_false: css`
      /* no title styles */
    `,
  };
});
```

**组件文件：**

```typescript
const Component = ({ closable, hasTitle }) => {
  const className = cx(
    styles.root,
    styles[`root_closable_${!!closable}`],
    styles[`root_hasTitle_${!!hasTitle}`],
  );
  return <div className={className} />;
};
```

**已优化示例：**

- `Alert`: `closable`, `hasTitle`, `showIcon` → 8 个组合（2×2×2）
- `Image`: `alwaysShowActions` → 2 个样式
- `StoryBook`: `noPadding` → 2 个样式

### 场景 4: isDarkMode → 静态样式拆分

**适用：** 依赖 `isDarkMode` 的条件样式

**有两种处理方式：**

#### 方式 A: 直接条件选择（简单场景）

**步骤：**

1. 创建 `Dark` 和 `Light` 两个静态样式
2. 运行时根据 `theme.isDarkMode` 选择

**示例：**

**样式文件：**

```typescript
export const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    rootDark: css`
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorTextLightSolid};
    `,
    rootLight: css`
      background: ${cssVar.colorFillQuaternary};
      color: ${cssVar.colorText};
    `,
  };
});
```

**组件文件：**

```typescript
import { useThemeMode } from 'antd-style';

const Component = () => {
  const { isDarkMode } = useThemeMode();
  return (
    <div
      className={cx(
        isDarkMode ? styles.rootDark : styles.rootLight
      )}
    />
  );
};
```

#### 方式 B: 使用 cva 将 isDarkMode 作为 variant（推荐，适用于复杂场景）

**步骤：**

1. 创建 `Dark` 和 `Light` 两个静态样式
2. 在 `cva` 中将 `isDarkMode` 作为 variant prop
3. 运行时直接传入 `isDarkMode` 值

**示例：**

**样式文件：**

```typescript
import { createStaticStyles } from 'antd-style';
import { cva } from 'class-variance-authority';

export const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    filledDark: css`
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorTextLightSolid};
    `,
    filledLight: css`
      background: ${cssVar.colorFillQuaternary};
      color: ${cssVar.colorText};
    `,
    outlined: css`
      border: 1px solid ${cssVar.colorBorder};
    `,
    root: css`
      /* base styles */
    `,
  };
});

export const variants = cva(styles.root, {
  defaultVariants: {
    isDarkMode: false,
    variant: 'filled',
  },
  variants: {
    isDarkMode: {
      false: null,
      true: null, // isDarkMode 本身不添加样式，通过 compoundVariants 组合
    },
    variant: {
      filled: null, // variant 本身不添加样式，通过 compoundVariants 组合
      outlined: styles.outlined,
    },
  },
  compoundVariants: [
    {
      class: styles.filledDark,
      isDarkMode: true,
      variant: 'filled',
    },
    {
      class: styles.filledLight,
      isDarkMode: false,
      variant: 'filled',
    },
  ],
});
```

**组件文件：**

```typescript
import { useThemeMode } from 'antd-style';
import { variants } from './style';

const Component = ({ variant = 'filled' }) => {
  const { isDarkMode } = useThemeMode();
  return (
    <div
      className={variants({ isDarkMode, variant })}
    />
  );
};
```

**优势：**

- ✅ 不需要 `useMemo` 动态创建 variants
- ✅ 更符合 `cva` 的设计理念
- ✅ 代码更简洁，性能更好
- ✅ 类型安全，IDE 自动补全

**已优化示例：**

- `TypewriterEffect`: `textDark` / `textLight`（方式 A）
- `Collapse`: `filledDark` / `filledLight`（可优化为方式 B）
- `Hotkey`: `inverseThemeDark` / `inverseThemeLight`（可优化为方式 B）
- `GuideCard`: `filledDark` / `filledLight`（可优化为方式 B）
- `GradientButton`: `buttonDark` / `buttonLight`（方式 A）

### 场景 5: responsive → 静态 responsive

**适用：** 使用响应式断点

**步骤：**

1. 导入静态 `responsive` from `antd-style`
2. 使用 `responsive.sm` 替代 `responsive.mobile`
3. 从 `createStyles` 参数中移除 `responsive`

**示例：**

**之前：**

```typescript
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, responsive }) => ({
  root: css`
    ${responsive.mobile} {
      padding: 12px;
    }
  `,
}));
```

**之后：**

```typescript
import { createStaticStyles } from 'antd-style';
import { responsive } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    ${responsive.sm} {
      padding: 12px;
    }
  `,
}));
```

**注意：**

- `responsive.mobile` → `responsive.sm`
- 静态 `responsive` 提供：`xs`, `sm`, `md`, `lg`, `xl`, `xxl`

**已优化示例：**

- `Header`: `responsive.mobile` → `responsive.sm`
- `FormModal`: `responsive.mobile` → `responsive.sm`
- `Hero`: `responsive.mobile` → `responsive.sm`

### 场景 6: stylish → lobeStaticStylish

**适用：** 使用自定义 `stylish` 工具

**步骤：**

1. 导入 `lobeStaticStylish` from `@/styles`
2. 替换 `stylish.xxx` → `lobeStaticStylish.xxx`

**示例：**

**之前：**

```typescript
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, stylish }) => ({
  root: css`
    ${stylish.blur};
    ${stylish.variantFilled};
  `,
}));
```

**之后：**

```typescript
import { createStaticStyles } from 'antd-style';

import { lobeStaticStylish } from '@/styles';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    ${lobeStaticStylish.blur};
    ${lobeStaticStylish.variantFilled};
  `,
}));
```

**已优化示例：**

- `Button`: `stylish.blur` → `lobeStaticStylish.blur`
- `Hero`: `stylish.gradientAnimation` → `lobeStaticStylish.gradientAnimation`

### 场景 7: prefixCls → 硬编码

**适用：** 使用动态 `prefixCls` 参数

**步骤：**

1. 在文件顶部硬编码 `const prefixCls = 'ant'`
2. 从 `createStyles` 参数中移除 `prefixCls`

**示例：**

**之前：**

```typescript
export const useStyles = createStyles(({ css }, prefixCls: string) => ({
  root: css`
    .${prefixCls}-button {
      /* styles */
    }
  `,
}));
```

**之后：**

```typescript
const prefixCls = 'ant';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    .${prefixCls}-button {
      /* styles */
    }
  `,
}));
```

**已优化示例：**

- `Alert`, `Collapse`, `FormModal`, `Image`, `Burger`, `DraggablePanel`, `DraggableSideNav`, `Toc`, `ColorSwatches`, `EmojiPicker`, `Form`, `awesome/Features`

### 场景 8: readableColor () → Token 替换

**适用：** 使用 `readableColor()` 计算对比色

**规则：**

- `readableColor(token.colorPrimary)` → `cssVar.colorTextLightSolid`（主色背景用白色文字）
- `readableColor(token.colorTextQuaternary)` → `cssVar.colorText`（浅色背景用深色文字）

**示例：**

**之前：**

```typescript
import { readableColor } from 'polished';

export const useStyles = createStyles(({ css, token }) => ({
  checked: css`
    background-color: ${token.colorPrimary};
    color: ${readableColor(token.colorPrimary)};
  `,
}));
```

**之后：**

```typescript
export const styles = createStaticStyles(({ css, cssVar }) => ({
  checked: css`
    background-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorTextLightSolid};
  `,
}));
```

**已优化示例：**

- `Checkbox`: `readableColor(token.colorPrimary)` → `cssVar.colorTextLightSolid`

### 场景 9: rgba () → color-mix ()

**适用：** 使用 `rgba()` 设置透明度

**步骤：**

1. 使用 CSS 原生的 `color-mix()` 函数
2. 格式：`color-mix(in srgb, ${cssVar.xxx} alpha%, transparent)`

**示例：**

**之前：**

```typescript
import { rgba } from 'polished';

export const useStyles = createStyles(({ css, token }) => ({
  root: css`
    background-color: ${rgba(token.colorBgLayout, 0.4)};
  `,
}));
```

**之后：**

```typescript
export const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    background-color: color-mix(in srgb, ${cssVar.colorBgLayout} 40%, transparent);
  `,
}));
```

**已优化示例：**

- `Header`: `rgba(cssVar.colorBgLayout, 0.4)` → `color-mix(...)`
- `FormModal`: `rgba(cssVar.colorBgContainer, 0)` → `color-mix(...)`

### 场景 10: keyframes → css

**适用：** 使用 `keyframes` 创建动画

**步骤：**

1. 在 `createStaticStyles` 外部定义 `keyframes`
2. 在样式内部使用

**示例：**

**之前：**

```typescript
export const useStyles = createStyles(({ css, keyframes }) => {
  const spin = keyframes`
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  `;
  return {
    icon: css`
      animation: ${spin} 1s linear infinite;
    `,
  };
});
```

**之后：**

```typescript
import { keyframes } from 'antd-style';

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

export const styles = createStaticStyles(({ css }) => ({
  icon: css`
    animation: ${spin} 1s linear infinite;
  `,
}));
```

**已优化示例：**

- `Icon`: `keyframes` 动画
- `Skeleton`: `keyframes` shimmer 动画

## ⚠️ 反模式：避免使用 createVariants (isDarkMode)

**不推荐的做法：**

```typescript
// ❌ 不推荐：在组件中动态创建 variants
export const createVariants = (isDarkMode: boolean) =>
  cva(styles.root, {
    variants: {
      variant: {
        filled: isDarkMode ? styles.filledDark : styles.filledLight,
      },
    },
  });

// 组件中
const variants = useMemo(() => createVariants(isDarkMode), [isDarkMode]);
```

**推荐的做法：**

将 `isDarkMode` 作为 `cva` 的 variant prop（见场景 4 方式 B），这样：

- ✅ 不需要 `useMemo` 动态创建
- ✅ 更符合 `cva` 的设计理念
- ✅ 代码更简洁，性能更好
- ✅ 类型安全，IDE 自动补全

```typescript
// ✅ 推荐：将 isDarkMode 作为 variant prop
export const variants = cva(styles.root, {
  variants: {
    isDarkMode: {
      false: null,
      true: null,
    },
    variant: {
      filled: null,
    },
  },
  compoundVariants: [
    {
      class: styles.filledDark,
      isDarkMode: true,
      variant: 'filled',
    },
    {
      class: styles.filledLight,
      isDarkMode: false,
      variant: 'filled',
    },
  ],
});

// 组件中
const { isDarkMode } = useThemeMode();
const className = variants({ isDarkMode, variant: 'filled' });
```

## ⚠️ 无法优化的场景

### 1. JS 计算函数

**无法优化：**

- `chroma()` - 颜色计算库
- `readableColor()` - 需要运行时计算（但可以用 token 替代）
- `mix()` - 颜色混合计算
- `calc()` 中使用 token 数值进行复杂计算

**示例：**

```typescript
// ❌ 无法优化
const scale = chroma.bezier([token.colorText, backgroundColor]).scale().colors(6);
```

### 2. 复杂的动态 Props

**无法优化：**

- 需要复杂计算的 props
- 对象 / 数组类型的 props
- 函数类型的 props

### 3. useTheme Hook

**无法优化：**

- 直接使用 `useTheme()` hook 获取运行时值
- 例如：`awesome/Giscus/style.ts` 使用 `useTheme()` 获取主题值

## 📋 迁移检查清单

### 样式文件检查

- [ ] `createStyles` → `createStaticStyles`
- [ ] `token.xxx` → `cssVar.xxx`
- [ ] 移除 `px` 后缀（`cssVar` 已包含单位）
- [ ] `responsive.mobile` → `responsive.sm`（如果使用）
- [ ] `stylish.xxx` → `lobeStaticStylish.xxx`（如果使用）
- [ ] `rgba()` → `color-mix()`（如果使用）
- [ ] `readableColor()` → token 替换（如果使用）
- [ ] `prefixCls` 参数 → 硬编码 `const prefixCls = 'ant'`（如果使用）
- [ ] `isDarkMode` → 静态样式拆分（如果使用）
- [ ] 动态 props → CSS 变量（如果使用）

### 组件文件检查

- [ ] `useStyles()` → `import { styles } from './style'`
- [ ] `import { cx } from 'antd-style'`（如果需要）
- [ ] `import { useTheme } from 'antd-style'`（如果需要 `theme.isDarkMode`）
- [ ] 动态 props → CSS 变量设置（如果使用）
- [ ] `isDarkMode` 条件 → `theme.isDarkMode` 判断（如果使用）

## 🎯 优化优先级

### 高优先级（简单优化）

1. ✅ 纯静态样式（无动态 props）
2. ✅ `isDarkMode` 拆分
3. ✅ `responsive.mobile` → `responsive.sm`
4. ✅ `stylish` → `lobeStaticStylish`
5. ✅ `readableColor()` → token 替换

### 中优先级（需要转换）

6. ✅ 简单的动态 props → CSS 变量（1-2 个）
7. ✅ 布尔值 props → 静态样式拆分（2-3 个）

### 低优先级（复杂优化）

8. ⚠️ 多个动态 props → CSS 变量（3+ 个）
9. ⚠️ 复杂的条件逻辑拆分

## 📚 参考示例

### 完整示例 1: 简单组件

**样式文件：**

```typescript
import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    padding: ${cssVar.padding};
    color: ${cssVar.colorText};
    border-radius: ${cssVar.borderRadius};
  `,
}));
```

**组件文件：**

```typescript
import { cx } from 'antd-style';
import { styles } from './style';

const Component = ({ className }) => {
  return <div className={cx(styles.root, className)} />;
};
```

### 完整示例 2: 带动态 Props

**样式文件：**

```typescript
import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    width: var(--component-size, 24px);
    height: var(--component-size, 24px);
    background: ${cssVar.colorBgContainer};
  `,
}));
```

**组件文件：**

```typescript
import { cx } from 'antd-style';
import { useMemo } from 'react';
import { styles } from './style';

const Component = ({ size = 24, className, style, ...rest }) => {
  const cssVariables = useMemo<Record<string, string>>(
    () => ({
      '--component-size': `${size}px`,
    }),
    [size],
  );

  return (
    <div
      className={cx(styles.root, className)}
      style={{
        ...cssVariables,
        ...style,
      }}
      {...rest}
    />
  );
};
```

### 完整示例 3: 带 isDarkMode

**样式文件：**

```typescript
import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  rootDark: css`
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextLightSolid};
  `,
  rootLight: css`
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
  `,
}));
```

**组件文件：**

```typescript
import { cx, useTheme } from 'antd-style';
import { styles } from './style';

const Component = ({ className }) => {
  const { theme } = useTheme();
  return (
    <div
      className={cx(
        theme.isDarkMode ? styles.rootDark : styles.rootLight,
        className
      )}
    />
  );
};
```

## 🔍 验证步骤

1. **类型检查：** `pnpm run type-check`
2. **运行时测试：** 确保视觉效果一致
3. **性能验证：** 检查样式计算是否在模块加载时完成

## 📊 优化效果

- ✅ **零运行时开销**：样式在模块加载时计算一次
- ✅ **减少重新渲染**：组件不再依赖样式 hook
- ✅ **更好的性能**：减少每次渲染的计算开销
- ✅ **代码更简洁**：直接导入样式对象

## 🔧 场景 11: useTheme () → useThemeMode () /cssVar

**适用：** 组件中只使用 `theme.isDarkMode` 或其他 token 值

**规则：**

- 如果只使用 `theme.isDarkMode`，使用 `const { isDarkMode } = useThemeMode()` 替代
- 如果使用其他 token（如 `theme.colorText`, `theme.borderRadius` 等），使用 `cssVar` 替代
- `useThemeMode()` 比 `useTheme()` 更轻量，只返回 `isDarkMode` 值

**示例：**

**之前：**

```typescript
import { useTheme } from 'antd-style';

const Component = () => {
  const theme = useTheme();
  return (
    <div className={theme.isDarkMode ? styles.dark : styles.light}>
      {theme.colorText}
    </div>
  );
};
```

**之后：**

```typescript
import { cssVar, useThemeMode } from 'antd-style';

const Component = () => {
  const { isDarkMode } = useThemeMode();
  return (
    <div className={isDarkMode ? styles.dark : styles.light}>
      {cssVar.colorText}
    </div>
  );
};
```

**已优化示例：**

- `AuroraBackground`, `Select`, `Input`, `Button`, `DatePicker`, `AutoComplete`, `InputNumber`, `InputPassword`, `InputOPT`, `TextArea`, `SpotlightCardItem`, `Spotlight`, `HotkeyInput` - 只使用 `isDarkMode` → `useThemeMode()`
- `Image`, `GradientButton`, `Empty`, `FileTypeIcon`, `FormSubmitFooter`, `CodeEditor`, `ModelNet`, `Drawer`, `Modal`, `Avatar`, `AvatarGroup`, `SkeletonAvatar`, `SkeletonButton`, `SkeletonTags`, `Callout`, `ModelNet`, `GridBackground`, `FolderIcon`, `FileIcon`, `TokenTag`, `ChatSendButton`, `AvatarUploader` - 使用 token → `cssVar`

**无法优化的文件（需要保留 `useTheme()`）：**

- `useMermaid`, `useStreamMermaid`, `useHighlight`, `useStreamHighlight` - 需要完整的 theme 对象传给第三方库
- `Alert`, `Tag`, `Menu`, `EmojiPicker` - 需要实际颜色值传给颜色计算函数
- `SkeletonTitle`, `SkeletonTags` - 需要数值进行数学运算
- `GridShowcase`, `GridBackground/demos` - 需要实际颜色值传给 `rgba()` 函数
- `CustomFonts` - 需要实际字符串值进行字符串拼接
- `Giscus/style.ts` - 需要实际颜色值传给 `readableColor()` 和 `rgba()` 函数（其他 token 已优化为 `cssVar`）

**注意事项：**

- `useThemeMode()` 只返回 `{ isDarkMode }`，不返回完整的 theme 对象
- `cssVar` 的值是字符串（如 `"14px"`, `"#ffffff"`），可以直接在 JSX 中使用
- 如果 token 需要用于数值计算（如 `Math.round(theme.fontSize * 1.5)`），需要保留 `useTheme()`

## 🎉 总结

`createStaticStyles` 迁移是一个渐进式的优化过程。对于简单的静态样式，可以直接转换；对于复杂的动态场景，需要根据具体情况选择合适的优化策略。关键是要理解每种场景的处理方式，并灵活运用 CSS 变量、静态样式拆分等技术。

### useTheme () 优化总结

- ✅ **使用 `useThemeMode()`**：当组件只使用 `theme.isDarkMode` 时
- ✅ **使用 `cssVar`**：当组件使用其他 token 值（颜色、尺寸等）时
- ⚠️ **保留 `useTheme()`**：当 token 需要用于数值计算或传给第三方库时
