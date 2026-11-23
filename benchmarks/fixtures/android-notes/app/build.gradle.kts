plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.example.notes"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.example.notes"
        minSdk = 26
        targetSdk = 35
    }
    buildFeatures { viewBinding = true }
}

dependencies {
    implementation(project(":core:data"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.viewmodel)
    testImplementation(libs.junit)
}
