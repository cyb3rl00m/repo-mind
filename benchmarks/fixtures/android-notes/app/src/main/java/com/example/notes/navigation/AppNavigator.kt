package com.example.notes.navigation

import android.content.Context
import android.content.Intent
import com.example.notes.settings.SettingsActivity

/** Central navigation helper shared by all screens. */
object AppNavigator {
    fun openSettings(context: Context) {
        context.startActivity(Intent(context, SettingsActivity::class.java))
    }
}
