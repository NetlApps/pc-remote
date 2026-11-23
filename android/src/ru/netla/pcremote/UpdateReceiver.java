package ru.netla.pcremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

/** Показывает результат установки OTA-обновления и диалог подтверждения. */
public class UpdateReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    int status =
        intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    String detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
      if (confirm != null) {
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
          context.startActivity(confirm);
        } catch (Exception error) {
          Toast.makeText(
                  context,
                  "Не удалось открыть установщик: " + error.getMessage(),
                  Toast.LENGTH_LONG)
              .show();
        }
      }
      return;
    }

    if (status == PackageInstaller.STATUS_SUCCESS) {
      Toast.makeText(context, "Обновление установлено", Toast.LENGTH_LONG).show();
      return;
    }

    String message = "Не удалось установить обновление";
    if (detail != null && !detail.trim().isEmpty()) {
      message += ": " + detail;
    }
    Toast.makeText(context, message, Toast.LENGTH_LONG).show();
  }
}
