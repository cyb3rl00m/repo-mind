package com.example.notes.settings

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.example.notes.R

class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        title = getString(R.string.settings_title)
    }
}
