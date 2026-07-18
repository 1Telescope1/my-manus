<?php

/** 为本项目的 Adminer 登录页预填非敏感连接信息。 */
final class AdminerProjectLoginDefaults extends Adminer\Plugin
{
    /** 调整驱动和文本输入的默认值，但不触发登录或处理密码。 */
    public function loginFormField($name, $heading, $value)
    {
        if ($name === 'driver') {
            $driver = getenv('ADMINER_DEFAULT_DRIVER') ?: 'pgsql';
            $value = preg_replace('/ selected(?=>)/', '', $value);
            $value = str_replace(
                sprintf('<option value="%s">', htmlspecialchars($driver, ENT_QUOTES)),
                sprintf('<option value="%s" selected>', htmlspecialchars($driver, ENT_QUOTES)),
                $value,
            );
            return $heading . $value . "\n";
        }

        $defaultValue = match ($name) {
            'username' => getenv('ADMINER_DEFAULT_USERNAME') ?: '',
            'db' => getenv('ADMINER_DEFAULT_DB') ?: '',
            default => '',
        };
        if ($defaultValue === '') {
            return null;
        }

        $fieldName = preg_quote($name, '/');
        $value = preg_replace_callback(
            '/(<input\b[^>]*\bname="auth\[' . $fieldName . '\]"[^>]*\bvalue=")[^"]*(")/',
            static fn (array $matches): string => $matches[1]
                . htmlspecialchars($defaultValue, ENT_QUOTES)
                . $matches[2],
            $value,
            1,
        );
        return $heading . $value . "\n";
    }
}

return new AdminerProjectLoginDefaults();
