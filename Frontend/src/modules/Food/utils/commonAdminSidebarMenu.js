export const commonAdminSidebarMenu = [
  {
    type: "section",
    label: "Settings",
    permissionKey: "settings",
    items: [
      {
        type: "link",
        label: "App Settings",
        permissionKey: "app_settings",
        path: "/admin/global-settings/app",
        icon: "Settings",
      },
      {
        type: "link",
        label: "Admin Settings",
        permissionKey: "admin_settings",
        path: "/admin/global-settings/admin",
        icon: "UserCog",
      },
    ]
  }
];
