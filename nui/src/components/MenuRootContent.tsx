import React from "react";
import { Box, Collapse, styled, Typography } from "@mui/material";
import { PageTabs} from "@nui/src/components/misc/PageTabs";
import { txAdminMenuPage, usePageValue } from "@nui/src/state/page.state";
import { MainPageList } from "@nui/src/components/MainPage/MainPageList";
import { useServerCtxValue } from "@nui/src/state/server.state";
import { useDebounce } from "@nui/src/hooks/useDebouce";

const TxAdminLogo: React.FC = () => (
  <Box my={1} display="flex" justifyContent="center">
    <img src="https://ogs.asia/templates/ogs/img/theme-dark-logo.png" alt="txAdmin logo" />
  </Box>
);

const StyledRoot = styled(Box)(({ theme }) => ({
  height: "fit-content",
  background: theme.palette.background.default,
  width: 325,
  borderRadius: 15,
  display: "flex",
  flexDirection: "column",
  userSelect: "none",
}));

export const MenuRootContent: React.FC = React.memo(() => {
  const serverCtx = useServerCtxValue();
  const curPage = usePageValue()
  const padSize = Math.max(0, 9 - serverCtx.txAdminVersion.length);
  const versionPad = "\u0020\u205F".repeat(padSize);

  // Hack to prevent collapse transition from breaking
  // In some cases, i.e, when setting target player from playerModal
  // Collapse transition can break due to multiple page updates within a short
  // time frame
  const debouncedCurPage = useDebounce(curPage, 50)

  return (
    <StyledRoot p={2} pb={1}>
      <TxAdminLogo />
      <Typography
        color="textSecondary"
        style={{
          fontWeight: 500,
          marginTop: -20,
          textAlign: "right",
          fontSize: 12,
        }}
      >
        v{serverCtx.txAdminVersion}
        {versionPad}
      </Typography>
      <PageTabs />
      <Collapse
        in={debouncedCurPage === txAdminMenuPage.Main}
        unmountOnExit
        mountOnEnter
      >
        <MainPageList />
      </Collapse>
    </StyledRoot>)
});