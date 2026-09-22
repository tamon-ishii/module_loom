package com.moduleloom;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

public class OpenInModuleLoomAction extends AnAction implements DumbAware {

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) return;

        VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
        if (file == null) return;

        ModuleLoomToolWindowFactory.openFileInToolWindow(project, file);
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);

        boolean visible = project != null && file != null &&
                (file.isDirectory() || "py".equalsIgnoreCase(file.getExtension()));
        e.getPresentation().setEnabledAndVisible(visible);

        if (visible) {
            if (file.isDirectory()) {
                e.getPresentation().setText("ModuleLoom で解析: " + file.getName());
            } else {
                e.getPresentation().setText("ModuleLoom で依存図を開く: " + file.getName());
            }
        }
    }
}
